import type { Chat, ChatMessage, CodexAccount, Prisma } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { basename, join } from "node:path"
import type {
  ChatAttachmentInput,
  ChatMessageAttachment,
  CodexCollaborationMode,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  ChatResponse,
  ChatMessageResponse,
  ChatEventPayloads,
  ChatEventType,
  ContextWindowUsagePayload,
  CodexReasoningEffort,
  CodexPermissionMode,
  CodexServiceTier,
  CodexJsonRpcResponse,
  CreateChatRequest,
  ExecuteChatRequest,
  JsonObject,
  JsonSerializable,
  ServerRequestResponseRequest,
  UpdateChatRequest,
} from "@/types"
import {
  codexRuntimeService,
  jsonRpcIdKey,
  readCodexRateLimitsForAccount,
  resolveAccountCodexHome,
} from "./codex-runtime.server"
import { normalizeEnvironment } from "./env.server"
import { HttpError } from "./http.server"
import { asJsonObject, readString } from "./json.server"
import {
  isInternalEnvironmentContext,
  importLocalCodexChats,
  type ImportedLocalMessage,
  type LocalCodexSessionIndexMetadata,
  mirrorImportedCodexSessionForAccount,
  readCodexSessionIndexFile,
  readLatestLocalCodexContextUsageForChat,
  readLocalCodexSessionTranscriptForChat,
} from "./local-codex-import.server"
import { prisma } from "./prisma.server"
import { publishChatEvent } from "./realtime.server"
import { resolveDirectory } from "./workspaces.server"
import { readWorkspaceFileMetadata } from "./workspace-files.server"

type PersistedChatMessage = ChatMessage
type PersistedChat = Chat

type SourceTranscriptMessage = {
  completedAt?: Date | null
  content: string
  createdAt?: Date | null
  itemId?: string | null
  kind?: ChatMessageResponse["kind"]
  metadata?: JsonObject
  rawPayload?: unknown
  role: Extract<ChatMessageResponse["role"], "ASSISTANT" | "SYSTEM" | "USER">
  source: "runtime" | "session"
  turnId?: string | null
}

type CodexRuntimeSession = {
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<CodexJsonRpcResponse>
  waitForEvent(
    predicate: (message: CodexJsonRpcResponse) => boolean,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<CodexJsonRpcResponse>
  onEvent(handler: (message: CodexJsonRpcResponse) => void): () => void
  onServerRequest(handler: (message: CodexJsonRpcResponse) => void): () => void
  respondToServerRequest(id: string | number, result: JsonSerializable): void
  rejectServerRequest(id: string | number, code: number, message: string): void
}

type PendingServerRequest = {
  chatId: string
  requestId: string
  requestKind: "approval" | "permissions" | "userInput"
  rpcId: string | number
  runtime: Pick<CodexRuntimeSession, "rejectServerRequest" | "respondToServerRequest">
  messageId: string
}

type ActiveRunState = {
  chatId: string
  externalThreadId?: string | null
  interruptRequested: boolean
  permissionMode: CodexPermissionMode
  runId: string
  runtime?: CodexRuntimeSession
  turnId?: string
}

type PreparedAttachment = {
  fallbackText?: string
  message: ChatMessageAttachment
  runtime: Record<string, unknown>
}

type QueuedTurn = {
  accountId: string
  attachments: PreparedAttachment[]
  automaticTitleSeed: string | null
  collaborationMode: CodexCollaborationMode
  content: string
  createdAt: Date
  id: string
  messageId: string
  metadata: Record<string, unknown>
  permissionMode: CodexPermissionMode
  workingDirectory: string
}

const pendingServerRequests = new Map<string, PendingServerRequest>()
const activeRuns = new Map<string, ActiveRunState>()
const queuedTurnsByChatId = new Map<string, QueuedTurn[]>()
const accountRunLocks = new Map<string, Promise<void>>()
const queueFlushLocks = new Map<string, Promise<void>>()
const chatSequenceLocks = new Map<string, Promise<void>>()
const runProjectionQueues = new Map<string, Promise<void>>()
const timelineMessageLocks = new Map<string, Promise<void>>()

async function withChatSequenceLock<T>(
  chatId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = chatSequenceLocks.get(chatId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.catch(() => undefined).then(() => current)
  chatSequenceLocks.set(chatId, next)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (chatSequenceLocks.get(chatId) === next) {
      chatSequenceLocks.delete(chatId)
    }
  }
}

async function withAccountRunLock<T>(
  accountId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = accountRunLocks.get(accountId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.catch(() => undefined).then(() => current)
  accountRunLocks.set(accountId, next)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (accountRunLocks.get(accountId) === next) {
      accountRunLocks.delete(accountId)
    }
  }
}

function createSequencedChatMessage(
  chatId: string,
  data: Omit<Prisma.ChatMessageUncheckedCreateInput, "chatId" | "sequence">,
): Promise<ChatMessage> {
  return withChatSequenceLock(chatId, async () =>
    prisma.chatMessage.create({
      data: {
        ...data,
        chatId,
        sequence: await nextSequence(chatId),
      },
    }),
  )
}

function enqueueRunProjection(
  runId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = runProjectionQueues.get(runId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  const stored = current.catch(() => undefined)
  runProjectionQueues.set(runId, stored)
  void stored.finally(() => {
    if (runProjectionQueues.get(runId) === stored) {
      runProjectionQueues.delete(runId)
    }
  })
  return current
}

async function drainRunProjectionQueue(runId: string): Promise<void> {
  await runProjectionQueues.get(runId)?.catch(() => undefined)
}

async function withTimelineMessageLock<T>(
  key: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  if (!key) {
    return operation()
  }

  const previous = timelineMessageLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.catch(() => undefined).then(() => current)
  timelineMessageLocks.set(key, next)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (timelineMessageLocks.get(key) === next) {
      timelineMessageLocks.delete(key)
    }
  }
}

export async function createChat(dto: CreateChatRequest) {
  const account = await prisma.codexAccount.findUnique({
    where: { id: dto.accountId },
  })
  if (!account) {
    throw new HttpError(400, "Account not found.")
  }
  if (account.status !== "CONNECTED") {
    throw new HttpError(400, "Authenticate the account before starting a chat.")
  }

  return prisma.chat.create({
    data: {
      accountId: dto.accountId,
      autoRotateAccount: dto.autoRotateAccount,
      workingDirectory: resolveDirectory(dto.workingDirectory),
      model: dto.model === undefined ? undefined : normalizeNullableRuntimeOption(dto.model),
      reasoningEffort:
        dto.reasoningEffort === undefined
          ? undefined
          : normalizeReasoningEffort(dto.reasoningEffort),
      serviceTier:
        dto.serviceTier === undefined
          ? undefined
          : normalizeServiceTier(dto.serviceTier),
      collaborationMode:
        dto.collaborationMode === undefined
          ? undefined
          : normalizeCollaborationMode(dto.collaborationMode),
      permissionMode:
        dto.permissionMode === undefined
          ? undefined
          : normalizePermissionMode(dto.permissionMode),
      title: dto.title ?? "Untitled chat",
    },
  })
}

export async function listChats() {
  const existingChats = await readVisibleChats()

  if (existingChats.length) {
    void refreshLocalChatIndex().catch((error) => {
      console.warn(
        "Failed to refresh local chat index.",
        error instanceof Error ? error.message : error,
      )
    })
    return existingChats
  }

  await refreshLocalChatIndex()
  return readVisibleChats()
}

async function refreshLocalChatIndex(): Promise<void> {
  await importLocalCodexChats()
  await syncThreadIndexMetadata()
}

function readVisibleChats() {
  return prisma.chat.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: [{ lastActivityAt: "desc" }, { updatedAt: "desc" }],
  })
}

export async function getChat(chatId: string) {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } })
  if (!chat) {
    throw new HttpError(404, "Chat not found.")
  }
  return hydrateChatFromThreadIndex(chat)
}

export async function updateChat(chatId: string, dto: UpdateChatRequest) {
  const chat = await getChat(chatId)
  const accountId = await resolveUpdatedChatAccountId(chat, dto.accountId)
  const accountChanged = accountId !== undefined && accountId !== chat.accountId
  const collaborationMode =
    dto.collaborationMode === undefined
      ? undefined
      : normalizeCollaborationMode(dto.collaborationMode)
  const collaborationModeChanged =
    collaborationMode !== undefined &&
    collaborationMode !== normalizeStoredCollaborationMode(chat.collaborationMode)
  const permissionMode =
    dto.permissionMode === undefined
      ? undefined
      : normalizePermissionMode(dto.permissionMode)
  const permissionModeChanged =
    permissionMode !== undefined &&
    permissionMode !== normalizeStoredPermissionMode(chat.permissionMode)
  if (dto.workingDirectory !== undefined) {
    throw new HttpError(400, "Chat working directory cannot be changed.")
  }
  if (accountChanged && chat.status === "RUNNING") {
    throw new HttpError(400, "Wait for the current run to finish before switching accounts.")
  }
  if (collaborationModeChanged && chat.status === "RUNNING") {
    throw new HttpError(400, "Wait for the current run to finish before changing modes.")
  }
  const updated = await prisma.chat.update({
    where: { id: chatId },
    data: {
      accountId,
      autoRotateAccount: dto.autoRotateAccount,
      model: dto.model === undefined ? undefined : normalizeNullableRuntimeOption(dto.model),
      reasoningEffort:
        dto.reasoningEffort === undefined
          ? undefined
          : normalizeReasoningEffort(dto.reasoningEffort),
      serviceTier:
        dto.serviceTier === undefined
          ? undefined
          : normalizeServiceTier(dto.serviceTier),
      collaborationMode,
      permissionMode,
      title: dto.title,
      externalThreadId:
        (accountChanged && !!chat.accountId) || collaborationModeChanged
          ? null
          : undefined,
    },
  })
  if (accountChanged && !chat.accountId && accountId) {
    void mirrorImportedCodexSessionForAccount(chatId, accountId).catch((error) => {
      console.warn(
        "Failed to mirror imported Codex session.",
        error instanceof Error ? error.message : error,
      )
    })
  }
  if (dto.title !== undefined) {
    void persistChatTitleToCodex(updated).catch((error) => {
      console.warn(
        "Failed to persist Codex chat title.",
        error instanceof Error ? error.message : error,
      )
    })
  }
  if (permissionModeChanged && permissionMode !== undefined) {
    setActiveChatPermissionMode(chatId, permissionMode)
    if (permissionMode === "fullAccess") {
      await resolvePendingServerRequestsForFullAccess(chatId)
    }
  }
  return updated
}

async function resolveUpdatedChatAccountId(
  chat: Awaited<ReturnType<typeof getChat>>,
  accountId: string | null | undefined,
): Promise<string | null | undefined> {
  if (accountId === undefined || accountId === chat.accountId) {
    return undefined
  }
  if (accountId === null) {
    return null
  }

  const account = await prisma.codexAccount.findUnique({
    where: { id: accountId },
  })
  if (!account) {
    throw new HttpError(400, "Account not found.")
  }
  if (account.status !== "CONNECTED") {
    throw new HttpError(400, "Authenticate the account before attaching it to a chat.")
  }
  return account.id
}

function normalizeNullableRuntimeOption(value: string | null): string | null {
  if (value === null) {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new HttpError(400, "Runtime option cannot be empty.")
  }
  return trimmed
}

function normalizeReasoningEffort(
  value: CodexReasoningEffort | null,
): CodexReasoningEffort | null {
  if (value === null) {
    return null
  }
  const allowed: CodexReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]
  if (!allowed.includes(value)) {
    throw new HttpError(400, "reasoningEffort is invalid.")
  }
  return value
}

function normalizeServiceTier(value: CodexServiceTier | null): CodexServiceTier | null {
  if (value === null || value === "fast" || value === "flex") {
    return value
  }
  throw new HttpError(400, "serviceTier is invalid.")
}

function normalizeCollaborationMode(
  value: CodexCollaborationMode | null,
): CodexCollaborationMode {
  if (value === null || value === "default") {
    return "default"
  }
  if (value === "plan") {
    return value
  }
  throw new HttpError(400, "collaborationMode is invalid.")
}

function normalizeStoredCollaborationMode(
  value: string | null | undefined,
): CodexCollaborationMode {
  return value === "plan" ? "plan" : "default"
}

function normalizePermissionMode(
  value: CodexPermissionMode | null,
): CodexPermissionMode {
  if (value === null || value === "default") {
    return "default"
  }
  if (value === "fullAccess") {
    return value
  }
  throw new HttpError(400, "permissionMode is invalid.")
}

function normalizeStoredPermissionMode(
  value: string | null | undefined,
): CodexPermissionMode {
  return value === "fullAccess" ? "fullAccess" : "default"
}

async function automaticChatTitleSeed(
  chatId: string,
  currentTitle: string | null | undefined,
  currentContent: string,
): Promise<string | null> {
  if (!isGenericChatTitle(currentTitle)) {
    return null
  }

  const existingUserMessage = await prisma.chatMessage.findFirst({
    where: {
      chatId,
      kind: "CHAT",
      role: "USER",
      content: { not: "" },
    },
    orderBy: { sequence: "asc" },
  })
  const seed = existingUserMessage?.content ?? currentContent
  const trimmed = seed.trim()
  return trimmed ? trimmed : null
}

async function applyFallbackChatTitleIfAllowed(
  chatId: string,
  seed: string | null,
): Promise<string | null> {
  const fallbackTitle = seed ? fallbackChatTitle(seed) : null
  if (!fallbackTitle) {
    return null
  }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { title: true },
  })
  if (!chat || !isGenericChatTitle(chat.title)) {
    return null
  }

  await updateChatTitleFromCodex(chatId, fallbackTitle)
  return fallbackTitle
}

async function hydrateChatFromThreadIndex(chat: Chat): Promise<Chat> {
  if (!chat.accountId || !chat.externalThreadId) {
    return chat
  }
  return refreshChatFromThreadIndex(chat, chat.accountId, chat.externalThreadId)
}

function isGenericChatTitle(value: string | null | undefined): boolean {
  const normalized = normalizeTitleComparisonValue(value)
  return (
    !normalized ||
    normalized === "untitled chat" ||
    normalized === "conversation" ||
    normalized === "new chat" ||
    normalized === "chat"
  )
}

function fallbackChatTitle(seed: string): string | null {
  const words = seed
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean)
    .slice(0, 5)
  if (!words.length) {
    return null
  }
  const title = words.join(" ")
  return `${title.charAt(0).toUpperCase()}${title.slice(1)}`.slice(0, 80)
}

async function syncThreadIndexMetadata(): Promise<void> {
  const chats = await prisma.chat.findMany({
    where: {
      accountId: { not: null },
      externalThreadId: { not: null },
      status: { not: "ARCHIVED" },
    },
    select: {
      accountId: true,
      externalThreadId: true,
      id: true,
      lastActivityAt: true,
      title: true,
    },
  })
  const accountIds = [
    ...new Set(
      chats
        .map((chat) => chat.accountId)
        .filter((accountId): accountId is string => !!accountId),
    ),
  ]
  if (!accountIds.length) {
    return
  }

  const indexes = new Map<
    string,
    Awaited<ReturnType<typeof readCodexSessionIndexFile>>
  >()
  await Promise.all(
    accountIds.map(async (accountId) => {
      indexes.set(
        accountId,
        await readCodexSessionIndexFile(
          join(resolveAccountCodexHome(accountId), "session_index.jsonl"),
        ),
      )
    }),
  )

  for (const chat of chats) {
    if (!chat.accountId || !chat.externalThreadId) {
      continue
    }
    const metadata = indexes.get(chat.accountId)?.get(chat.externalThreadId)
    const data = threadIndexChatUpdate(chat, metadata)
    if (data) {
      const updated = await prisma.chat.update({ where: { id: chat.id }, data })
      emit(chat.id, "chat.updated", toChatResponse(updated))
    }
  }
}

async function refreshChatFromThreadIndex(
  chat: Chat,
  accountId: string,
  threadId: string,
): Promise<Chat> {
  const index = await readCodexSessionIndexFile(
    join(resolveAccountCodexHome(accountId), "session_index.jsonl"),
  )
  const data = threadIndexChatUpdate(chat, index.get(threadId))
  if (!data) {
    return chat
  }
  const updated = await prisma.chat.update({ where: { id: chat.id }, data })
  emit(chat.id, "chat.updated", toChatResponse(updated))
  return updated
}

function threadIndexChatUpdate(
  chat: Pick<Chat, "lastActivityAt" | "title">,
  metadata: LocalCodexSessionIndexMetadata | null | undefined,
): Prisma.ChatUpdateInput | null {
  if (!metadata) {
    return null
  }
  const data: Prisma.ChatUpdateInput = {}
  if (
    metadata.title &&
    normalizeTitleComparisonValue(chat.title) !==
      normalizeTitleComparisonValue(metadata.title) &&
    (!isGenericChatTitle(metadata.title) || isGenericChatTitle(chat.title))
  ) {
    data.title = metadata.title
  }
  if (
    metadata.updatedAt &&
    chat.lastActivityAt.getTime() !== metadata.updatedAt.getTime()
  ) {
    data.lastActivityAt = metadata.updatedAt
  }
  return Object.keys(data).length ? data : null
}

export async function archiveChat(chatId: string) {
  await getChat(chatId)
  return prisma.chat.update({
    where: { id: chatId },
    data: { status: "ARCHIVED" },
  })
}

export async function listMessages(chatId: string, afterSequence = 0, limit = 50) {
  const chat = await getChat(chatId)
  await reconcileSettledRunMessages(chatId)
  const safeLimit = Math.min(Math.max(limit, 1), 200)
  const data = await listSourceBackedMessages(chat, afterSequence, safeLimit)
  return {
    data,
    nextCursor: data.length ? data[data.length - 1].sequence : null,
  }
}

export async function readChatContext(chatId: string) {
  const chat = await getChat(chatId)
  if (!chat.externalThreadId) {
    return { usage: null }
  }
  return {
    usage: await readLatestLocalCodexContextUsageForChat(
      chat.id,
      chat.externalThreadId,
    ),
  }
}

async function listSourceBackedMessages(
  chat: Chat,
  afterSequence: number,
  limit: number,
): Promise<ChatMessageResponse[]> {
  const localMessages = await prisma.chatMessage.findMany({
    where: { chatId: chat.id },
    orderBy: { sequence: "asc" },
  })
  const sourceMessages =
    chat.status === "RUNNING" ? [] : await readCodexTranscriptMessages(chat)
  const messages = sourceMessages.length
    ? mergeSourceTranscriptMessages(chat, sourceMessages, localMessages)
    : localMessages.map(toChatMessageResponse)

  return messages
    .filter((message) => message.sequence > afterSequence)
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, limit)
}

async function readCodexTranscriptMessages(
  chat: Chat,
): Promise<SourceTranscriptMessage[]> {
  if (!chat.externalThreadId) {
    return []
  }

  const runtimeMessages = await readRuntimeTranscriptMessages(chat)
  if (runtimeMessages.length) {
    return runtimeMessages
  }

  const session = await readLocalCodexSessionTranscriptForChat(
    chat.id,
    chat.externalThreadId,
  )
  return session
    ? session.messages.map((message) => sourceMessageFromLocalSession(message))
    : []
}

async function readRuntimeTranscriptMessages(
  chat: Chat,
): Promise<SourceTranscriptMessage[]> {
  if (!chat.accountId || !chat.externalThreadId) {
    return []
  }
  const account = await prisma.codexAccount.findUnique({
    where: { id: chat.accountId },
  })
  if (!account || account.status !== "CONNECTED") {
    return []
  }
  const runtime = codexRuntimeService.getRuntime({
    accountId: account.id,
    command: account.command,
    args: normalizeAccountArgs(account.args),
    workingDirectory: null,
    environment: normalizeEnvironment(account.environment),
  })

  try {
    const response = await runtime.request(
      "thread/turns/list",
      { threadId: chat.externalThreadId, limit: 1_000 },
      30_000,
    )
    const messages = sourceMessagesFromTurns(response.result)
    if (messages.length) {
      return messages
    }
  } catch {
    // Fall back to thread/read and then the on-disk session transcript.
  }

  try {
    const response = await runtime.request(
      "thread/read",
      { includeTurns: true, threadId: chat.externalThreadId },
      30_000,
    )
    return sourceMessagesFromTurns(response.result)
  } catch {
    return []
  }
}

function mergeSourceTranscriptMessages(
  chat: Chat,
  sourceMessages: SourceTranscriptMessage[],
  localMessages: PersistedChatMessage[],
): ChatMessageResponse[] {
  const localTranscriptMessages = localMessages.filter(isLocalTranscriptMessage)
  const matchedLocalIds = new Set<string>()
  const sourceRoles = new Set(sourceMessages.map((message) => message.role))
  let nextSyntheticSequence = Math.max(
    0,
    ...localMessages.map((message) => message.sequence),
  )

  const sourceResponses = sourceMessages.map((source, index) => {
    const local = findNextLocalTranscriptMessage(
      source,
      localTranscriptMessages,
      matchedLocalIds,
    )
    if (local) {
      matchedLocalIds.add(local.id)
    }
    const sequence = local?.sequence ?? ++nextSyntheticSequence
    return sourceTranscriptResponse(chat, source, index, local, sequence)
  })

  const localProjection = localMessages
    .filter((message) => !matchedLocalIds.has(message.id))
    .filter((message) => shouldKeepLocalProjectionMessage(message, sourceRoles))
    .map(toChatMessageResponse)

  return [...sourceResponses, ...localProjection].sort(
    (left, right) => left.sequence - right.sequence,
  )
}

function isLocalTranscriptMessage(message: PersistedChatMessage): boolean {
  return (
    message.kind === "CHAT" &&
    (message.role === "USER" || message.role === "ASSISTANT")
  )
}

function shouldKeepLocalProjectionMessage(
  message: PersistedChatMessage,
  sourceRoles: Set<SourceTranscriptMessage["role"]>,
): boolean {
  if (message.kind !== "CHAT") {
    return true
  }
  if (message.status !== "COMPLETED") {
    return true
  }
  if (!isLocalTranscriptMessage(message)) {
    return true
  }
  return !sourceRoles.has(message.role as SourceTranscriptMessage["role"])
}

function findNextLocalTranscriptMessage(
  source: SourceTranscriptMessage,
  localMessages: PersistedChatMessage[],
  matchedLocalIds: Set<string>,
): PersistedChatMessage | null {
  return (
    localMessages.find(
      (message) =>
        !matchedLocalIds.has(message.id) &&
        message.role === source.role &&
        source.itemId &&
        message.itemId === source.itemId,
    ) ??
    localMessages.find(
      (message) =>
        !matchedLocalIds.has(message.id) &&
        message.role === source.role &&
        source.turnId &&
        message.turnId === source.turnId,
    ) ??
    localMessages.find(
      (message) =>
        !matchedLocalIds.has(message.id) && message.role === source.role,
    ) ??
    null
  )
}

function sourceTranscriptResponse(
  chat: Chat,
  source: SourceTranscriptMessage,
  index: number,
  local: PersistedChatMessage | null,
  sequence: number,
): ChatMessageResponse {
  const createdAt = source.createdAt ?? local?.createdAt ?? chat.createdAt
  const completedAt = source.completedAt ?? source.createdAt ?? local?.completedAt
  return {
    chatId: chat.id,
    completedAt,
    content: source.content,
    createdAt,
    id:
      local?.id ??
      sourceTranscriptId(chat.id, chat.externalThreadId, source, index),
    itemId: source.itemId ?? local?.itemId ?? null,
    kind: source.kind ?? "CHAT",
    metadata:
      (source.metadata
        ? (toSerializable(source.metadata) as ChatMessageResponse["metadata"])
        : null) ??
      (local?.metadata as ChatMessageResponse["metadata"] | null) ??
      sourceTranscriptMetadata(source),
    rawPayload: toSerializable(source.rawPayload ?? local?.rawPayload ?? null),
    requestId: local?.requestId ?? null,
    role: source.role,
    runId: local?.runId ?? null,
    sequence,
    status: local?.status === "FAILED" ? "FAILED" : "COMPLETED",
    turnId: source.turnId ?? local?.turnId ?? null,
  }
}

function sourceTranscriptId(
  chatId: string,
  threadId: string | null,
  source: SourceTranscriptMessage,
  index: number,
): string {
  return [
    "codex",
    chatId,
    threadId ?? "thread",
    source.turnId ?? "turn",
    source.itemId ?? index,
    source.role.toLowerCase(),
  ].join(":")
}

function sourceTranscriptMetadata(
  source: SourceTranscriptMessage,
): ChatMessageResponse["metadata"] {
  return {
    kind: "codexTranscript",
    source: source.source,
  }
}

function sourceMessageFromLocalSession(
  message: ImportedLocalMessage,
): SourceTranscriptMessage {
  return {
    completedAt: message.createdAt,
    content: message.content,
    createdAt: message.createdAt,
    metadata: message.metadata,
    kind: message.kind,
    rawPayload: message.rawPayload,
    role: message.role,
    source: "session",
  }
}

function sourceMessagesFromTurns(value: unknown): SourceTranscriptMessage[] {
  return readTurnObjects(value).flatMap((turn) => sourceMessagesFromTurn(turn))
}

function readTurnObjects(value: unknown): JsonObject[] {
  const root = asJsonObject(value)
  const thread = asJsonObject(root?.thread)
  const candidates = [
    Array.isArray(value) ? value : null,
    root?.data,
    root?.items,
    root?.turns,
    thread?.turns,
  ]
  for (const candidate of candidates) {
    const rows = readJsonObjectArray(candidate)
    if (rows) {
      return rows
    }
  }
  return []
}

function sourceMessagesFromTurn(turn: JsonObject): SourceTranscriptMessage[] {
  const turnId =
    readString(turn.id) ??
    readString(turn.turnId) ??
    readString(turn.turn_id) ??
    null
  const createdAt = readDateValue(
    turn.createdAt ?? turn.created_at ?? turn.timestamp ?? turn.startedAt,
  )
  const completedAt = readDateValue(
    turn.completedAt ?? turn.completed_at ?? turn.finishedAt ?? turn.updatedAt,
  )
  const items = readJsonObjectArray(turn.items) ?? []
  return items
    .map((item) =>
      sourceMessageFromTurnItem(item, {
        completedAt,
        createdAt,
        turnId,
      }),
    )
    .filter((message): message is SourceTranscriptMessage => !!message)
}

function sourceMessageFromTurnItem(
  item: JsonObject,
  turn: {
    completedAt?: Date | null
    createdAt?: Date | null
    turnId?: string | null
  },
): SourceTranscriptMessage | null {
  const role = sourceItemRole(item)
  if (!role) {
    return null
  }
  const content = sourceItemText(item)
  if (!content.trim() || isInternalEnvironmentContext(content)) {
    return null
  }
  return {
    completedAt:
      readDateValue(item.completedAt ?? item.completed_at) ?? turn.completedAt,
    content,
    createdAt:
      readDateValue(item.createdAt ?? item.created_at ?? item.timestamp) ??
      turn.createdAt,
    itemId:
      readString(item.id) ??
      readString(item.itemId) ??
      readString(item.item_id) ??
      null,
    rawPayload: compactSourceTurnItem(item),
    role,
    source: "runtime",
    turnId:
      readString(item.turnId) ??
      readString(item.turn_id) ??
      turn.turnId ??
      null,
  }
}

function sourceItemRole(
  item: JsonObject,
): SourceTranscriptMessage["role"] | null {
  const role = readString(item.role)?.toLowerCase()
  if (role === "user") {
    return "USER"
  }
  if (role === "assistant" || role === "agent") {
    return "ASSISTANT"
  }

  const type = readString(item.type)?.replace(/[_\s-]+/g, "").toLowerCase()
  if (type === "usermessage" || type === "inputmessage") {
    return "USER"
  }
  if (type === "agentmessage" || type === "assistantmessage") {
    return "ASSISTANT"
  }
  return null
}

function sourceItemText(item: JsonObject): string {
  const text =
    readText(item.text) ??
    readText(item.message) ??
    readText(item.output) ??
    readContentText(item.content) ??
    ""
  return appendSourceImageTags(text, item)
}

function readContentText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value
  }
  if (!Array.isArray(value)) {
    return undefined
  }
  const text = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry
      }
      const object = asJsonObject(entry)
      return (
        readText(object?.text) ??
        readText(object?.content) ??
        readText(object?.message) ??
        sourceImageTagFromObject(object) ??
        ""
      )
    })
    .join("")
  return text.length ? text : undefined
}

function appendSourceImageTags(content: string, item: JsonObject): string {
  const tags = [
    ...sourceImageTagsFromArray(item.images),
    ...sourceImageTagsFromArray(item.local_images),
    ...sourceImageTagsFromArray(item.localImages),
  ]
  return [content, ...tags].filter(Boolean).join("\n\n")
}

function sourceImageTagsFromArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) =>
      typeof entry === "string"
        ? sourceImageTagFromString(entry)
        : sourceImageTagFromObject(asJsonObject(entry)),
    )
    .filter((entry): entry is string => !!entry)
}

function sourceImageTagFromObject(object: JsonObject | undefined): string | null {
  if (!object) {
    return null
  }
  return sourceImageTagFromString(
    readString(object.url) ??
      readString(object.image_url) ??
      readString(object.path) ??
      readString(object.filePath),
  )
}

function sourceImageTagFromString(value: string | undefined): string | null {
  const src = value?.trim()
  return src ? `<image>${src}</image>` : null
}

function readJsonObjectArray(value: unknown): JsonObject[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => !!entry)
}

function readDateValue(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function compactSourceTurnItem(item: JsonObject): JsonObject {
  return {
    id: readString(item.id),
    itemId: readString(item.itemId) ?? readString(item.item_id),
    role: readString(item.role),
    type: readString(item.type),
  }
}

async function reconcileSettledRunMessages(chatId: string): Promise<void> {
  const runs = await prisma.chatRun.findMany({
    where: {
      chatId,
      status: { in: ["CANCELLED", "COMPLETED", "FAILED"] },
    },
    select: { id: true, status: true },
  })

  for (const run of runs) {
    const status = run.status === "FAILED" ? "FAILED" : "COMPLETED"
    await prisma.chatMessage.updateMany({
      where: {
        chatId,
        kind: {
          in: [
            "CHAT",
            "COMMAND_EXECUTION",
            "FILE_CHANGE",
            "PLAN",
            "THINKING",
            "TOOL_ACTIVITY",
          ],
        },
        runId: run.id,
        status: { in: ["PENDING", "STREAMING"] },
      },
      data: {
        completedAt: new Date(),
        status,
      },
    })
  }
}

export async function respondToCodexServerRequest(
  chatId: string,
  requestId: string,
  dto: ServerRequestResponseRequest,
) {
  await getChat(chatId)
  const key = serverRequestKey(chatId, requestId)
  const pending = pendingServerRequests.get(key)
  if (!pending) {
    throw new HttpError(410, "Server request is no longer active.")
  }

  const result = serverRequestResult(dto)
  pending.runtime.respondToServerRequest(pending.rpcId, result)
  pendingServerRequests.delete(key)

  const updated = await prisma.chatMessage.update({
    where: { id: pending.messageId },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      metadata: mergeMetadata(
        await messageMetadata(pending.messageId),
        {
          status: "resolved",
          decision: dto.decision,
          result: dto.result ?? result,
          resolvedAt: new Date().toISOString(),
        },
      ),
    },
  })
  const response = toChatMessageResponse(updated)
  emit(chatId, "message.updated", response)
  return response
}

export async function executeMessage(chatId: string, dto: ExecuteChatRequest) {
  let chat = await getChat(chatId)
  if (dto.accountId && chat.accountId && dto.accountId !== chat.accountId) {
    throw new HttpError(400, "Switch the chat account before sending with a different account.")
  }
  if (!dto.accountId && chat.status !== "RUNNING") {
    chat = await autoRotateChatAccountIfNeeded(chat)
  }
  const accountId = dto.accountId ?? chat.accountId
  if (!accountId) {
    throw new HttpError(400, "Choose a Codex account before sending messages.")
  }
  const account = await prisma.codexAccount.findUnique({
    where: { id: accountId },
  })
  if (!account) {
    throw new HttpError(400, "Account not found.")
  }
  if (account.status !== "CONNECTED") {
    throw new HttpError(400, "Authenticate the account before sending messages.")
  }
  if (!chat.workingDirectory) {
    throw new HttpError(400, "Select a working directory before sending messages.")
  }
  const workingDirectory = resolveDirectory(chat.workingDirectory)
  const attachments = await prepareChatAttachments(
    workingDirectory,
    dto.attachments ?? [],
  )
  const messageContent = userMessageContent(dto.content, attachments)
  if (!messageContent.trim() && !attachments.length) {
    throw new HttpError(400, "Message content or an attachment is required.")
  }
  const automaticTitleSeed = await automaticChatTitleSeed(
    chatId,
    chat.title,
    automaticTitleContent(dto.content, attachments),
  )
  await applyFallbackChatTitleIfAllowed(chatId, automaticTitleSeed)
  const requestedCollaborationMode =
    dto.collaborationMode === undefined
      ? undefined
      : normalizeCollaborationMode(dto.collaborationMode)
  const collaborationMode =
    requestedCollaborationMode ?? normalizeStoredCollaborationMode(chat.collaborationMode)
  const permissionMode = normalizeStoredPermissionMode(chat.permissionMode)
  const startedAt = new Date()

  if (chat.status === "RUNNING") {
    if (dto.delivery === "steer") {
      return steerActiveRunMessage({
        accountId,
        attachments,
        chat,
        collaborationMode,
        content: dto.content,
        messageContent,
        metadata: dto.metadata ?? {},
        permissionMode,
        startedAt,
        workingDirectory,
      })
    }
    return queueActiveRunMessage({
      accountId,
      attachments,
      automaticTitleSeed,
      chat,
      collaborationMode,
      content: dto.content,
      messageContent,
      metadata: dto.metadata ?? {},
      permissionMode,
      queuedAt: startedAt,
      workingDirectory,
    })
  }

  const message = await createSequencedChatMessage(chatId, {
    role: "USER",
    status: "COMPLETED",
    content: messageContent,
    completedAt: startedAt,
    metadata: toJsonInput(messageMetadataWithAttachments(dto.metadata, attachments)),
  })
  emit(chatId, "message.created", toChatMessageResponse(message))
  const started = await startAssistantRunForMessage({
    accountId,
    attachments,
    automaticTitleSeed,
    chatId,
    collaborationMode,
    content: dto.content,
    metadata: dto.metadata ?? {},
    permissionMode,
    requestedCollaborationMode,
    startedAt,
    workingDirectory,
  })

  return {
    message: toChatMessageResponse(message),
    assistantMessage: toChatMessageResponse(started.assistantMessage),
    runId: started.run.id,
    status: "QUEUED" as const,
  }
}

async function queueActiveRunMessage({
  accountId,
  attachments,
  automaticTitleSeed,
  chat,
  collaborationMode,
  content,
  messageContent,
  metadata,
  permissionMode,
  queuedAt,
  workingDirectory,
}: {
  accountId: string
  attachments: PreparedAttachment[]
  automaticTitleSeed: string | null
  chat: Chat
  collaborationMode: CodexCollaborationMode
  content: string
  messageContent: string
  metadata: Record<string, unknown>
  permissionMode: CodexPermissionMode
  queuedAt: Date
  workingDirectory: string
}) {
  const queueId = randomUUID()
  const message = await createSequencedChatMessage(chat.id, {
    role: "USER",
    status: "COMPLETED",
    content: messageContent,
    completedAt: queuedAt,
    metadata: toJsonInput(
      messageMetadataWithAttachments(
        {
          ...metadata,
          delivery: "queue",
          queueId,
          queueStatus: "queued",
          queuedAt: queuedAt.toISOString(),
        },
        attachments,
      ),
    ),
  })
  appendQueuedTurn(chat.id, {
    accountId,
    attachments,
    automaticTitleSeed,
    collaborationMode,
    content,
    createdAt: queuedAt,
    id: queueId,
    messageId: message.id,
    metadata,
    permissionMode,
    workingDirectory,
  })
  const updated = await prisma.chat.update({
    where: { id: chat.id },
    data: { lastActivityAt: queuedAt, updatedAt: queuedAt },
  })
  emit(chat.id, "chat.updated", toChatResponse(updated))
  emit(chat.id, "message.created", toChatMessageResponse(message))
  return {
    message: toChatMessageResponse(message),
    assistantMessage: null,
    runId: null,
    status: "QUEUED" as const,
    delivery: "queue" as const,
    queued: true,
  }
}

async function steerActiveRunMessage({
  accountId,
  attachments,
  chat,
  collaborationMode,
  content,
  messageContent,
  metadata,
  permissionMode,
  startedAt,
  workingDirectory,
}: {
  accountId: string
  attachments: PreparedAttachment[]
  chat: Chat
  collaborationMode: CodexCollaborationMode
  content: string
  messageContent: string
  metadata: Record<string, unknown>
  permissionMode: CodexPermissionMode
  startedAt: Date
  workingDirectory: string
}) {
  void accountId
  void permissionMode
  void workingDirectory
  const activeRun = activeRunForChat(chat.id)
  if (!activeRun?.runtime) {
    throw new HttpError(409, "The active turn is not ready for steering yet.")
  }
  const threadId = activeRun.externalThreadId ?? chat.externalThreadId
  if (!threadId) {
    throw new HttpError(409, "The active turn has not published a thread yet.")
  }
  const expectedTurnId =
    activeRun.turnId ?? (await resolveInFlightTurnId(activeRun.runtime, threadId))
  if (!expectedTurnId) {
    throw new HttpError(409, "The active turn has not published a turn id yet.")
  }
  const currentChat = await prisma.chat.findUnique({ where: { id: chat.id } })
  const collaborationSettings = await resolveCollaborationModeSettings(
    activeRun.runtime,
    currentChat?.model ?? chat.model,
    (currentChat?.reasoningEffort ?? chat.reasoningEffort) as CodexReasoningEffort | null,
  )
  const response = await steerCodexTurn(
    activeRun.runtime,
    {
      expectedTurnId,
      threadId,
      ...turnSteerModeOverrides(collaborationMode, collaborationSettings),
    },
    content,
    attachments,
  )
  activeRun.turnId = getTurnId(response) ?? expectedTurnId
  activeRun.externalThreadId = threadId

  const message = await createSequencedChatMessage(chat.id, {
    role: "USER",
    status: "COMPLETED",
    content: messageContent,
    completedAt: startedAt,
    metadata: toJsonInput(
      messageMetadataWithAttachments(
        {
          ...metadata,
          delivery: "steer",
          steeredAt: startedAt.toISOString(),
        },
        attachments,
      ),
    ),
  })
  const updated = await prisma.chat.update({
    where: { id: chat.id },
    data: { lastActivityAt: startedAt, updatedAt: startedAt },
  })
  emit(chat.id, "chat.updated", toChatResponse(updated))
  emit(chat.id, "message.created", toChatMessageResponse(message))
  return {
    message: toChatMessageResponse(message),
    assistantMessage: null,
    runId: activeRun.runId,
    status: "RUNNING" as const,
    delivery: "steer" as const,
    steered: true,
  }
}

async function startAssistantRunForMessage({
  accountId,
  attachments,
  automaticTitleSeed,
  chatId,
  collaborationMode,
  content,
  metadata,
  permissionMode,
  requestedCollaborationMode,
  startedAt,
  workingDirectory,
}: {
  accountId: string
  attachments: PreparedAttachment[]
  automaticTitleSeed: string | null
  chatId: string
  collaborationMode: CodexCollaborationMode
  content: string
  metadata: Record<string, unknown>
  permissionMode: CodexPermissionMode
  requestedCollaborationMode?: CodexCollaborationMode | null
  startedAt: Date
  workingDirectory: string
}) {
  const run = await prisma.chatRun.create({
    data: {
      chatId,
      accountId,
      status: "QUEUED",
      request: toJsonInput({
        attachments: attachments.map((attachment) => attachment.message),
        collaborationMode,
        content,
        metadata,
        permissionMode,
        workingDirectory,
      }),
    },
  })
  const assistantMessage = await createSequencedChatMessage(chatId, {
    runId: run.id,
    role: "ASSISTANT",
    kind: "CHAT",
    status: "PENDING",
    content: "",
  })
  const runningChat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      collaborationMode: requestedCollaborationMode ?? undefined,
      lastActivityAt: startedAt,
      status: "RUNNING",
      updatedAt: startedAt,
    },
  })

  emit(chatId, "chat.updated", toChatResponse(runningChat))
  emit(chatId, "message.created", toChatMessageResponse(assistantMessage))
  emit(chatId, "run.status", { runId: run.id, status: "QUEUED" })
  void runCodex(
    chatId,
    run.id,
    assistantMessage.id,
    accountId,
    content,
    metadata,
    attachments,
    workingDirectory,
    collaborationMode,
    automaticTitleSeed,
  )
  return { assistantMessage, run }
}

function activeRunForChat(chatId: string): ActiveRunState | null {
  for (const activeRun of activeRuns.values()) {
    if (activeRun.chatId === chatId) {
      return activeRun
    }
  }
  return null
}

function setActiveChatPermissionMode(
  chatId: string,
  permissionMode: CodexPermissionMode,
): void {
  for (const activeRun of activeRuns.values()) {
    if (activeRun.chatId === chatId) {
      activeRun.permissionMode = permissionMode
    }
  }
}

async function resolvePendingServerRequestsForFullAccess(
  chatId: string,
): Promise<void> {
  const pendingRequests = [...pendingServerRequests.values()].filter(
    (pending) =>
      pending.chatId === chatId && pending.requestKind !== "userInput",
  )
  for (const pending of pendingRequests) {
    if (pending.requestKind === "userInput") {
      continue
    }
    const requestKind = pending.requestKind
    const result = fullAccessServerRequestResult(requestKind)
    pending.runtime.respondToServerRequest(pending.rpcId, result)
    pendingServerRequests.delete(serverRequestKey(chatId, pending.requestId))
    const message = await prisma.chatMessage.findUnique({
      where: { id: pending.messageId },
    })
    if (!message) {
      continue
    }
    const updated = await prisma.chatMessage.update({
      where: { id: message.id },
      data: {
        completedAt: new Date(),
        metadata: mergeMetadata(message.metadata, {
          autoApproved: true,
          decision: requestKind === "approval" ? "acceptForSession" : undefined,
          result,
          resolvedAt: new Date().toISOString(),
          status: "resolved",
        }),
        status: "COMPLETED",
      },
    })
    emit(chatId, "message.updated", toChatMessageResponse(updated))
  }
}

function appendQueuedTurn(chatId: string, queuedTurn: QueuedTurn): void {
  const queue = queuedTurnsByChatId.get(chatId) ?? []
  queuedTurnsByChatId.set(chatId, [...queue, queuedTurn])
}

function dequeueQueuedTurn(chatId: string): QueuedTurn | null {
  const queue = queuedTurnsByChatId.get(chatId) ?? []
  const [nextTurn, ...remaining] = queue
  if (!nextTurn) {
    queuedTurnsByChatId.delete(chatId)
    return null
  }
  if (remaining.length) {
    queuedTurnsByChatId.set(chatId, remaining)
  } else {
    queuedTurnsByChatId.delete(chatId)
  }
  return nextTurn
}

function scheduleQueuedTurnFlush(chatId: string): void {
  const previous = queueFlushLocks.get(chatId) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(() => flushNextQueuedTurn(chatId))
  const stored = current.catch(() => undefined)
  queueFlushLocks.set(chatId, stored)
  void stored.finally(() => {
    if (queueFlushLocks.get(chatId) === stored) {
      queueFlushLocks.delete(chatId)
    }
  })
}

function scheduleIdleAutoRotate(chatId: string): void {
  void autoRotateIdleChatAccount(chatId).catch((error) => {
    console.warn(
      "Failed to auto rotate idle chat account.",
      error instanceof Error ? error.message : error,
    )
  })
}

async function autoRotateIdleChatAccount(chatId: string): Promise<void> {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } })
  if (!chat || chat.status === "RUNNING") {
    return
  }
  await autoRotateChatAccountIfNeeded(chat)
}

async function flushNextQueuedTurn(chatId: string): Promise<void> {
  if (activeRunForChat(chatId)) {
    return
  }
  const chat = await prisma.chat.findUnique({ where: { id: chatId } })
  if (!chat || chat.status === "RUNNING") {
    return
  }
  const queuedTurn = dequeueQueuedTurn(chatId)
  if (!queuedTurn) {
    return
  }

  try {
    const activeChat = chat.autoRotateAccount
      ? await autoRotateChatAccountIfNeeded(chat)
      : chat
    const accountId = activeChat.accountId ?? queuedTurn.accountId
    const account = await prisma.codexAccount.findUnique({
      where: { id: accountId },
    })
    if (!account || account.status !== "CONNECTED") {
      throw new Error("Queued message account is no longer connected.")
    }
    const startedAt = new Date()
    const started = await startAssistantRunForMessage({
      accountId,
      attachments: queuedTurn.attachments,
      automaticTitleSeed: queuedTurn.automaticTitleSeed,
      chatId,
      collaborationMode: queuedTurn.collaborationMode,
      content: queuedTurn.content,
      metadata: queuedTurn.metadata,
      permissionMode: normalizeStoredPermissionMode(activeChat.permissionMode),
      requestedCollaborationMode: queuedTurn.collaborationMode,
      startedAt,
      workingDirectory: queuedTurn.workingDirectory,
    })
    await updateQueuedMessageStatus(chatId, queuedTurn.messageId, {
      dequeuedAt: startedAt.toISOString(),
      queueStatus: "running",
      runId: started.run.id,
    })
  } catch (error) {
    await updateQueuedMessageStatus(chatId, queuedTurn.messageId, {
      error: error instanceof Error ? error.message : "Queued message failed.",
      failedAt: new Date().toISOString(),
      queueStatus: "failed",
    })
  }
}

async function autoRotateChatAccountIfNeeded(chat: Chat): Promise<Chat> {
  if (
    !chat.autoRotateAccount ||
    chat.status === "RUNNING" ||
    activeRunForChat(chat.id)
  ) {
    return chat
  }

  const connectedAccounts = await prisma.codexAccount.findMany({
    where: { status: "CONNECTED" },
    orderBy: { createdAt: "asc" },
  })
  if (!connectedAccounts.length) {
    return chat
  }

  const snapshots = await readAccountRateLimitSnapshots(connectedAccounts)
  const currentAccount = connectedAccounts.find(
    (account) => account.id === chat.accountId,
  )
  const currentScore = currentAccount
    ? accountAvailabilityScore(snapshots.get(currentAccount.id))
    : -1
  if (currentAccount && currentScore >= 0) {
    return chat
  }

  const bestAccount = selectBestAvailableAccount(connectedAccounts, snapshots)
  if (!bestAccount || bestAccount.id === chat.accountId) {
    return chat
  }
  if (accountAvailabilityScore(snapshots.get(bestAccount.id)) < 0) {
    return chat
  }

  const updated = await prisma.chat.update({
    where: { id: chat.id },
    data: {
      accountId: bestAccount.id,
      externalThreadId: chat.accountId ? null : undefined,
    },
  })
  emit(chat.id, "chat.updated", toChatResponse(updated))

  if (!chat.accountId) {
    void mirrorImportedCodexSessionForAccount(chat.id, bestAccount.id).catch((error) => {
      console.warn(
        "Failed to mirror imported Codex session.",
        error instanceof Error ? error.message : error,
      )
    })
  }

  return updated
}

async function readAccountRateLimitSnapshots(
  accounts: CodexAccount[],
): Promise<Map<string, CodexRateLimitSnapshot | undefined>> {
  const snapshots = new Map<string, CodexRateLimitSnapshot | undefined>()
  const results = await Promise.allSettled(
    accounts.map(async (account) => ({
      accountId: account.id,
      snapshot: selectRateLimitSnapshot(
        await readCodexRateLimitsForAccount({
          accountId: account.id,
          args: normalizeAccountArgs(account.args),
          command: account.command,
          environment: normalizeEnvironment(account.environment),
          workingDirectory: null,
        }),
      ),
    })),
  )

  for (const result of results) {
    if (result.status === "fulfilled") {
      snapshots.set(result.value.accountId, result.value.snapshot)
    }
  }
  return snapshots
}

function selectRateLimitSnapshot(
  response: Awaited<ReturnType<typeof readCodexRateLimitsForAccount>>,
): CodexRateLimitSnapshot | undefined {
  return (
    response?.rateLimitsByLimitId?.codex ??
    Object.values(response?.rateLimitsByLimitId ?? {}).find(Boolean) ??
    response?.rateLimits
  )
}

function selectBestAvailableAccount(
  accounts: CodexAccount[],
  snapshots: Map<string, CodexRateLimitSnapshot | undefined>,
): CodexAccount | undefined {
  return accounts
    .map((account, index) => ({
      account,
      index,
      score: accountAvailabilityScore(snapshots.get(account.id)),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .at(0)?.account
}

function accountAvailabilityScore(snapshot?: CodexRateLimitSnapshot): number {
  if (!snapshot) {
    return 0
  }
  if (snapshot.rateLimitReachedType || usageCapacitySeverity(snapshot)) {
    return -1
  }
  if (snapshot.credits && !snapshot.credits.unlimited && !snapshot.credits.hasCredits) {
    return -1
  }
  if (snapshot.credits?.unlimited) {
    return 101
  }

  const remainingPercents = [snapshot.primary, snapshot.secondary]
    .filter((window): window is CodexRateLimitWindow => !!window)
    .map((window) => 100 - clampPercent(window.usedPercent))

  if (!remainingPercents.length) {
    return 0
  }
  return Math.min(...remainingPercents)
}

function usageCapacitySeverity(
  snapshot?: CodexRateLimitSnapshot,
): "fiveHour" | "weekly" | null {
  if (!snapshot) {
    return null
  }
  if (rateLimitWindowReached(snapshot.secondary)) {
    return "weekly"
  }
  if (rateLimitWindowReached(snapshot.primary)) {
    return "fiveHour"
  }
  return null
}

function rateLimitWindowReached(
  window: CodexRateLimitWindow | null | undefined,
): boolean {
  return clampPercent(window?.usedPercent ?? 0) >= 100
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
}

async function updateQueuedMessageStatus(
  chatId: string,
  messageId: string,
  patch: JsonObject,
): Promise<void> {
  const message = await prisma.chatMessage.findUnique({ where: { id: messageId } })
  if (!message) {
    return
  }
  const updated = await prisma.chatMessage.update({
    where: { id: messageId },
    data: { metadata: mergeMetadata(message.metadata, patch) },
  })
  emit(chatId, "message.updated", toChatMessageResponse(updated))
}

async function prepareChatAttachments(
  workingDirectory: string,
  inputs: ChatAttachmentInput[],
): Promise<PreparedAttachment[]> {
  if (inputs.length > 12) {
    throw new HttpError(400, "A message can include up to 12 attachments.")
  }
  const attachments: PreparedAttachment[] = []
  for (const input of inputs) {
    if (input.kind === "image") {
      attachments.push(prepareImageAttachment(input))
      continue
    }
    if (input.kind === "file") {
      attachments.push(await prepareFileAttachment(workingDirectory, input))
      continue
    }
    throw new HttpError(400, "Attachment kind is invalid.")
  }
  return attachments
}

function prepareImageAttachment(input: Extract<ChatAttachmentInput, { kind: "image" }>): PreparedAttachment {
  const dataUrl = input.dataUrl?.trim()
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl)
  if (!match) {
    throw new HttpError(400, "Image attachments must be data URLs.")
  }
  const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg")
  const base64 = match[2].replace(/\s+/g, "")
  const size = Buffer.byteLength(base64, "base64")
  if (size > 6 * 1024 * 1024) {
    throw new HttpError(400, "Image attachments must be 6 MB or smaller.")
  }
  const name = normalizeAttachmentName(input.name, mimeType.split("/").at(-1) ?? "image")
  const normalizedDataUrl = `data:${mimeType};base64,${base64}`
  return {
    message: {
      id: randomUUID(),
      kind: "image",
      mimeType,
      name,
      size,
      url: normalizedDataUrl,
    },
    runtime: {
      type: "image",
      url: normalizedDataUrl,
    },
  }
}

async function prepareFileAttachment(
  workingDirectory: string,
  input: Extract<ChatAttachmentInput, { kind: "file" }>,
): Promise<PreparedAttachment> {
  const file = await readWorkspaceFileMetadata(workingDirectory, input.path)
  return {
    fallbackText: `@${file.path}`,
    message: {
      id: randomUUID(),
      kind: "file",
      name: normalizeAttachmentName(input.name, file.name),
      path: file.path,
      size: file.size,
    },
    runtime: {
      path: file.path,
      text: `@${file.path}`,
      type: "mention",
    },
  }
}

function normalizeAttachmentName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  const name = trimmed ? basename(trimmed) : fallback
  return name.slice(0, 160) || "attachment"
}

function userMessageContent(
  content: string,
  attachments: PreparedAttachment[],
): string {
  const imageTags = attachments
    .map((attachment) => attachment.message)
    .filter((attachment): attachment is Extract<ChatMessageAttachment, { kind: "image" }> => attachment.kind === "image")
    .map((attachment) => `<image>${attachment.url}</image>`)
  return [content.trim(), ...imageTags].filter(Boolean).join("\n\n")
}

function automaticTitleContent(
  content: string,
  attachments: PreparedAttachment[],
): string {
  const attachmentText = attachments.map((attachment) =>
    attachment.message.kind === "file"
      ? attachment.message.path
      : attachment.message.name,
  )
  return [content.trim(), ...attachmentText].filter(Boolean).join(" ")
}

function messageMetadataWithAttachments(
  metadata: Record<string, unknown> | undefined,
  attachments: PreparedAttachment[],
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    ...(attachments.length
      ? { attachments: attachments.map((attachment) => attachment.message) }
      : {}),
  }
}

async function runCodex(
  chatId: string,
  runId: string,
  assistantMessageId: string,
  accountId: string,
  content: string,
  metadata: Record<string, unknown>,
  attachments: PreparedAttachment[],
  workingDirectory: string,
  collaborationMode: CodexCollaborationMode,
  automaticTitleSeed: string | null,
): Promise<void> {
  return withAccountRunLock(accountId, () =>
    runCodexWithAccountLock(
      chatId,
      runId,
      assistantMessageId,
      accountId,
      content,
      metadata,
      attachments,
      workingDirectory,
      collaborationMode,
      automaticTitleSeed,
    ),
  )
}

async function runCodexWithAccountLock(
  chatId: string,
  runId: string,
  assistantMessageId: string,
  accountId: string,
  content: string,
  metadata: Record<string, unknown>,
  attachments: PreparedAttachment[],
  workingDirectory: string,
  collaborationMode: CodexCollaborationMode,
  automaticTitleSeed: string | null,
): Promise<void> {
  const account = await prisma.codexAccount.findUnique({
    where: { id: accountId },
  })
  const chat = await prisma.chat.findUnique({ where: { id: chatId } })
  if (!account || !chat) {
    return
  }
  const permissionMode = normalizeStoredPermissionMode(chat.permissionMode)

  const assistant = await prisma.chatMessage.update({
    where: { id: assistantMessageId },
    data: { status: "STREAMING" },
  })
  emit(chatId, "message.updated", toChatMessageResponse(assistant))

  await prisma.chatRun.update({
    where: { id: runId },
    data: { status: "RUNNING", startedAt: new Date() },
  })
  emit(chatId, "run.status", { runId, status: "RUNNING" })

  const activeRun: ActiveRunState = {
    chatId,
    externalThreadId: chat.externalThreadId,
    interruptRequested: false,
    permissionMode,
    runId,
  }
  activeRuns.set(runId, activeRun)

  const runtime = codexRuntimeService.getRuntime({
    accountId: account.id,
    command: account.command,
    args: normalizeAccountArgs(account.args),
    workingDirectory: null,
    environment: normalizeEnvironment(account.environment),
  })
  activeRun.runtime = runtime
  let streamedContent = ""
  const streamBuffers = new Map<string, string>()
  let externalThreadId: string | null = chat.externalThreadId
  let turnId: string | undefined
  let terminalWaitAbort: AbortController | null = null
  let terminalEventPromise: Promise<CodexJsonRpcResponse> | null = null
  const unsubscribeEvents = runtime.onEvent((event) => {
    if (!eventBelongsToTurn(event, externalThreadId, turnId)) {
      return
    }
    void enqueueRunProjection(runId, () =>
      projectCodexEvent({
        assistantMessageId: assistant.id,
        chatId,
        streamBuffers,
        runId,
        onAssistantContent: (content) => {
          streamedContent = content
        },
      }, event),
    ).catch((error) =>
      logProjectionError("Codex event projection failed.", error),
    )
  })
  const unsubscribeRequests = runtime.onServerRequest((request) => {
    if (!serverRequestBelongsToTurn(request, externalThreadId, turnId)) {
      return
    }
    void enqueueRunProjection(runId, () =>
      projectCodexServerRequest({
        chatId,
        permissionMode: () => activeRun.permissionMode,
        runId,
        runtime,
      }, request),
    ).catch((error) =>
      logProjectionError("Codex server request projection failed.", error),
    )
  })

  try {
    externalThreadId = await ensureCodexThread(
      runtime,
      chat.externalThreadId,
      workingDirectory,
      collaborationMode,
    )
    activeRun.externalThreadId = externalThreadId
    scheduleAutomaticChatTitleIfNeeded({
      chatId,
      cwd: workingDirectory,
      runtime,
      seed: automaticTitleSeed,
      threadId: externalThreadId,
    })
    if (await runInterruptRequested(runId)) {
      activeRun.interruptRequested = true
    }
    const collaborationSettings = await resolveCollaborationModeSettings(
      runtime,
      chat.model,
      chat.reasoningEffort as CodexReasoningEffort | null,
    )
    terminalWaitAbort = new AbortController()
    terminalEventPromise = runtime.waitForEvent(
      (event) =>
        turnEventIsTerminal(event) &&
        readEventThreadId(event) === externalThreadId &&
        (!turnId || eventTurnId(event) === turnId),
      600_000,
      terminalWaitAbort.signal,
    )
    const turnResponse = await startCodexTurn(runtime, {
        threadId: externalThreadId,
        cwd: workingDirectory,
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.reasoningEffort ? { effort: chat.reasoningEffort } : {}),
        ...(chat.serviceTier ? { serviceTier: chat.serviceTier } : {}),
        ...turnModeOverrides(collaborationMode, collaborationSettings, permissionMode),
        metadata,
      },
      content,
      attachments,
    )
    turnId = getTurnId(turnResponse)
    activeRun.turnId = turnId
    if (turnId) {
      await prisma.chatRun.update({
        where: { id: runId },
        data: { externalTurnId: turnId },
      })
      if (activeRun.interruptRequested || (await runInterruptRequested(runId))) {
        activeRun.interruptRequested = true
        await sendTurnInterrupt(runtime, turnId, externalThreadId)
      }
    }
    const completedEvent = await terminalEventPromise
    await drainRunProjectionQueue(runId)
    if (turnEventIsInterrupted(completedEvent)) {
      throw new CodexRunInterruptedError(terminalTurnMessage(completedEvent))
    }
    if (turnEventIsFailure(completedEvent)) {
      throw new Error(terminalTurnMessage(completedEvent))
    }
    const historyContent = await readLatestAssistantText(
      runtime,
      externalThreadId,
      turnId,
    )
    const finalContent =
      historyContent ||
      extractAssistantText(completedEvent) ||
      extractAssistantText(turnResponse) ||
      streamedContent
    const finishedAt = new Date()
    const completed = await prisma.chatMessage.update({
      where: { id: assistant.id },
      data: {
        content: finalContent,
        status: "COMPLETED",
        rawPayload: toJsonInput(completedEvent),
        completedAt: finishedAt,
      },
    })
    await settleOpenRunTimelineMessages(chatId, runId, "COMPLETED")
    await expirePendingServerRequests(chatId, runId, "Codex completed the turn.")
    await prisma.chatRun.update({
      where: { id: runId },
      data: { status: "COMPLETED", endedAt: new Date() },
    })
    const resetCollaborationMode =
      collaborationMode === "plan" && (await runHasPlanResult(chatId, runId))
    const completedChat = await prisma.chat.update({
      where: { id: chatId },
      data: {
        collaborationMode: resetCollaborationMode ? "default" : undefined,
        status: "IDLE",
        externalThreadId,
        lastActivityAt: finishedAt,
        updatedAt: finishedAt,
      },
    })
    emit(chatId, "chat.updated", toChatResponse(completedChat))
    emit(chatId, "message.completed", toChatMessageResponse(completed))
    emit(chatId, "run.status", { runId, status: "COMPLETED" })
    await refreshChatTitleFromCodex(runtime, chatId, externalThreadId)
    await refreshChatFromThreadIndex(
      (await prisma.chat.findUnique({ where: { id: chatId } })) ?? completedChat,
      account.id,
      externalThreadId,
    )
  } catch (error) {
    terminalWaitAbort?.abort()
    await terminalEventPromise?.catch(() => undefined)
    const message = error instanceof Error ? error.message : "Codex run failed."
    await expirePendingServerRequests(chatId, runId, message)
    if (error instanceof CodexRunInterruptedError) {
      await settleOpenRunTimelineMessages(chatId, runId, "COMPLETED")
      const stoppedAt = new Date()
      const stopped = await prisma.chatMessage.update({
        where: { id: assistant.id },
        data: {
          status: "COMPLETED",
          content: streamedContent,
          completedAt: stoppedAt,
          metadata: mergeMetadata(assistant.metadata, {
            interrupted: true,
            kind: "assistant",
          }),
        },
      })
      await prisma.chatRun.update({
        where: { id: runId },
        data: { status: "CANCELLED", error: message, endedAt: new Date() },
      })
      const stoppedChat = await prisma.chat.update({
        where: { id: chatId },
        data: { lastActivityAt: stoppedAt, status: "IDLE", updatedAt: stoppedAt },
      })
      emit(chatId, "chat.updated", toChatResponse(stoppedChat))
      emit(chatId, "message.completed", toChatMessageResponse(stopped))
      emit(chatId, "run.status", {
        runId,
        status: "CANCELLED",
        error: message,
      })
      return
    }
    const failedAt = new Date()
    const failed = await prisma.chatMessage.update({
      where: { id: assistant.id },
      data: {
        status: "FAILED",
        content: streamedContent,
        completedAt: failedAt,
      },
    })
    await settleOpenRunTimelineMessages(chatId, runId, "FAILED")
    await prisma.chatRun.update({
      where: { id: runId },
      data: { status: "FAILED", error: message, endedAt: new Date() },
    })
    const failedChat = await prisma.chat.update({
      where: { id: chatId },
      data: { lastActivityAt: failedAt, status: "IDLE", updatedAt: failedAt },
    })
    emit(chatId, "chat.updated", toChatResponse(failedChat))
    emit(chatId, "message.failed", {
      ...toChatMessageResponse(failed),
      error: message,
    })
    emit(chatId, "run.status", {
      runId,
      status: "FAILED",
      error: message,
    })
  } finally {
    terminalWaitAbort?.abort()
    unsubscribeEvents()
    unsubscribeRequests()
    activeRuns.delete(runId)
    runProjectionQueues.delete(runId)
    if (queuedTurnsByChatId.has(chatId)) {
      scheduleQueuedTurnFlush(chatId)
    } else {
      scheduleIdleAutoRotate(chatId)
    }
  }
}

class CodexRunInterruptedError extends Error {}

export async function interruptChatRun(chatId: string) {
  const chat = await getChat(chatId)
  if (chat.status !== "RUNNING") {
    throw new HttpError(409, "There is no running task to stop.")
  }

  const run = await prisma.chatRun.findFirst({
    where: { chatId, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
  })
  if (!run) {
    throw new HttpError(409, "There is no active run to stop.")
  }

  const now = new Date()
  await prisma.chatRun.update({
    where: { id: run.id },
    data: { interruptRequestedAt: now },
  })

  const activeRun = activeRuns.get(run.id)
  if (activeRun) {
    activeRun.interruptRequested = true
    if (activeRun.runtime && activeRun.turnId) {
      await sendTurnInterrupt(
        activeRun.runtime,
        activeRun.turnId,
        activeRun.externalThreadId ?? chat.externalThreadId,
      )
    }
  }

  return {
    chatId,
    runId: run.id,
    status: run.status,
    message: activeRun?.turnId
      ? "Stop signal sent to Codex."
      : "Stop requested. Codex will be interrupted as soon as the turn starts.",
  }
}

async function runInterruptRequested(runId: string): Promise<boolean> {
  const run = await prisma.chatRun.findUnique({
    where: { id: runId },
    select: { interruptRequestedAt: true },
  })
  return !!run?.interruptRequestedAt
}

async function sendTurnInterrupt(
  runtime: Pick<CodexRuntimeSession, "request">,
  turnId: string,
  threadId?: string | null,
): Promise<void> {
  const params = {
    turnId,
    ...(threadId ? { threadId } : {}),
  }
  try {
    await runtime.request("turn/interrupt", params, 30_000)
    return
  } catch (error) {
    if (!shouldRetrySnakeCaseInterrupt(error)) {
      throw error
    }
  }
  await runtime.request(
    "turn/interrupt",
    {
      turn_id: turnId,
      ...(threadId ? { thread_id: threadId } : {}),
    },
    30_000,
  )
}

async function startCodexTurn(
  runtime: Pick<CodexRuntimeSession, "request">,
  params: Record<string, unknown>,
  content: string,
  attachments: PreparedAttachment[],
): Promise<CodexJsonRpcResponse> {
  const variants = turnInputVariants(content, attachments)
  let lastError: unknown
  for (const input of variants) {
    try {
      return await runtime.request(
        "turn/start",
        {
          ...params,
          input,
        },
        30_000,
      )
    } catch (error) {
      lastError = error
      if (!shouldRetryTurnInput(error)) {
        throw error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Codex turn failed.")
}

async function steerCodexTurn(
  runtime: Pick<CodexRuntimeSession, "request">,
  params: {
    expectedTurnId: string
    threadId: string
  } & Record<string, unknown>,
  content: string,
  attachments: PreparedAttachment[],
): Promise<CodexJsonRpcResponse> {
  async function sendWithExpectedTurn(
    expectedTurnId: string,
  ): Promise<CodexJsonRpcResponse> {
    const inputVariants = turnInputVariants(content, attachments)
    const paramVariants =
      params.collaborationMode === undefined
        ? [params]
        : [params, withoutKey(params, "collaborationMode")]
    let lastError: unknown
    for (const paramVariant of paramVariants) {
      for (const input of inputVariants) {
        try {
          return await runtime.request(
            "turn/steer",
            {
              ...paramVariant,
              expectedTurnId,
              input,
            },
            30_000,
          )
        } catch (error) {
          lastError = error
          if (
            paramVariant.collaborationMode !== undefined &&
            shouldRetryWithoutCollaborationMode(error)
          ) {
            break
          }
          if (shouldRetryTurnInput(error)) {
            continue
          }
          throw error
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Codex steer failed.")
  }

  try {
    return await sendWithExpectedTurn(params.expectedTurnId)
  } catch (error) {
    if (!shouldRetrySteerWithRefreshedTurnId(error)) {
      throw error
    }
    const refreshedTurnId = await resolveInFlightTurnId(runtime, params.threadId)
    if (!refreshedTurnId || refreshedTurnId === params.expectedTurnId) {
      throw error
    }
    return sendWithExpectedTurn(refreshedTurnId)
  }
}

function withoutKey<T extends Record<string, unknown>>(
  value: T,
  key: keyof T,
): Record<string, unknown> {
  const next = { ...value }
  delete next[key]
  return next
}

async function resolveInFlightTurnId(
  runtime: Pick<CodexRuntimeSession, "request">,
  threadId: string,
): Promise<string | null> {
  const attempts = 3
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await readThreadTurnStateSnapshot(runtime, threadId)
    if (snapshot.interruptibleTurnId) {
      return snapshot.interruptibleTurnId
    }
    if (snapshot.hasInterruptibleTurnWithoutId && attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      continue
    }
    return null
  }
  return null
}

async function readThreadTurnStateSnapshot(
  runtime: Pick<CodexRuntimeSession, "request">,
  threadId: string,
): Promise<{
  hasInterruptibleTurnWithoutId: boolean
  interruptibleTurnId: string | null
  latestTurnId: string | null
}> {
  try {
    const response = await runtime.request(
      "thread/turns/list",
      { limit: 8, sortDirection: "desc", threadId },
      10_000,
    )
    const result = asJsonObject(response.result)
    return turnStateSnapshot(
      readObjectArray(result?.data) ??
        readObjectArray(result?.items) ??
        readObjectArray(result?.turns) ??
        [],
      true,
    )
  } catch {
    // Older app-server builds only expose turns through thread/read.
  }

  let response: CodexJsonRpcResponse
  try {
    response = await runtime.request(
      "thread/read",
      { includeTurns: true, threadId },
      10_000,
    )
  } catch (error) {
    if (!shouldRetryThreadReadTurnSnapshotWithSnakeCase(error)) {
      throw error
    }
    response = await runtime.request(
      "thread/read",
      { include_turns: true, thread_id: threadId },
      10_000,
    )
  }
  const result = asJsonObject(response.result)
  const thread = asJsonObject(result?.thread)
  return turnStateSnapshot(readObjectArray(thread?.turns) ?? [], false)
}

function turnStateSnapshot(
  turnObjects: JsonObject[],
  newestFirst: boolean,
): {
  hasInterruptibleTurnWithoutId: boolean
  interruptibleTurnId: string | null
  latestTurnId: string | null
} {
  const newestTurns = newestFirst ? turnObjects : [...turnObjects].reverse()
  const latestTurnId =
    newestTurns
      .map((turn) => normalizeTurnIdentifier(readTurnId(turn)))
      .find(Boolean) ?? null
  let hasInterruptibleTurnWithoutId = false
  for (const turn of newestTurns) {
    if (!isInterruptibleTurnStatus(normalizeTurnStatus(turn))) {
      continue
    }
    const turnId = normalizeTurnIdentifier(readTurnId(turn))
    if (turnId) {
      return {
        hasInterruptibleTurnWithoutId: false,
        interruptibleTurnId: turnId,
        latestTurnId,
      }
    }
    hasInterruptibleTurnWithoutId = true
  }
  return {
    hasInterruptibleTurnWithoutId,
    interruptibleTurnId: null,
    latestTurnId,
  }
}

function readObjectArray(value: unknown): JsonObject[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value.map(asJsonObject).filter((entry): entry is JsonObject => !!entry)
}

function readTurnId(turn: JsonObject): string | null {
  return (
    readString(turn.id) ??
    readString(turn.turnId) ??
    readString(turn.turn_id) ??
    null
  )
}

function normalizeTurnIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeTurnStatus(turn: JsonObject): string | null {
  const status =
    readString(turn.status) ??
    readString(turn.turnStatus) ??
    readString(turn.turn_status)
  return status
    ?.replace(/[_-]/g, "")
    .trim()
    .toLowerCase() ?? null
}

function isInterruptibleTurnStatus(status: string | null): boolean {
  return (
    status === "running" ||
    status === "inprogress" ||
    status === "inflight" ||
    status === "pending" ||
    status === "queued" ||
    status === "started" ||
    status === "streaming"
  )
}

function turnInputVariants(
  content: string,
  attachments: PreparedAttachment[],
): Array<Array<Record<string, unknown>>> {
  const fallbackText = [content.trim(), ...attachments.flatMap((attachment) => attachment.fallbackText ?? [])]
    .filter(Boolean)
    .join("\n\n")
  const images = attachments.filter((attachment) => attachment.message.kind === "image")
  const mentions = attachments.filter((attachment) => attachment.message.kind === "file")
  const textItem = {
    type: "text",
    text: fallbackText,
    text_elements: [],
  }
  const build = (imageKey: "image_url" | "url", includeMentions: boolean) => [
    textItem,
    ...images.map((attachment) => ({
      type: "image",
      [imageKey]: (attachment.message as Extract<ChatMessageAttachment, { kind: "image" }>).url,
    })),
    ...(includeMentions ? mentions.map((attachment) => attachment.runtime) : []),
  ]
  const variants = [build("url", true)]
  if (images.length) {
    variants.push(build("image_url", true))
  }
  if (mentions.length) {
    variants.push(build("url", false))
    if (images.length) {
      variants.push(build("image_url", false))
    }
  }
  return variants
}

function shouldRetryTurnInput(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return (
    message.includes("input") ||
    message.includes("invalid") ||
    message.includes("unknown") ||
    message.includes("unsupported") ||
    message.includes("deserialize") ||
    message.includes("schema")
  )
}

function shouldRetrySnakeCaseInterrupt(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return (
    !message ||
    message.includes("invalid") ||
    message.includes("unknown") ||
    message.includes("missing") ||
    message.includes("param")
  )
}

function shouldRetrySteerWithRefreshedTurnId(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return [
    "turn not found",
    "no active turn",
    "not in progress",
    "not running",
    "already completed",
    "already finished",
    "invalid turn",
    "no such turn",
    "not active",
    "does not exist",
    "cannot steer",
  ].some((hint) => message.includes(hint))
}

function shouldRetryThreadReadTurnSnapshotWithSnakeCase(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return (
    message.includes("threadid") ||
    message.includes("includeturns") ||
    message.includes("thread_id") ||
    message.includes("include_turns") ||
    message.includes("unknown field") ||
    message.includes("missing field") ||
    message.includes("invalid")
  )
}

function shouldRetryWithoutCollaborationMode(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return (
    message.includes("collaboration") ||
    message.includes("unknown field") ||
    message.includes("unsupported") ||
    message.includes("schema")
  )
}

async function ensureCodexThread(
  runtime: {
    request(
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<CodexJsonRpcResponse>
  },
  threadId: string | null,
  workingDirectory: string | null,
  collaborationMode: CodexCollaborationMode,
): Promise<string> {
  const method = threadId ? "thread/resume" : "thread/start"
  const response = await runtime.request(
    method,
    {
      ...(threadId ? { threadId } : {}),
      cwd: workingDirectory,
      ...threadModeOverrides(collaborationMode),
    },
    30_000,
  )
  const result = asJsonObject(response.result)
  const thread = asJsonObject(result?.thread)
  const nextThreadId =
    readString(thread?.id) ??
    readString(result?.threadId) ??
    readString(result?.thread_id) ??
    threadId
  if (!nextThreadId) {
    throw new Error("Codex did not return a thread id.")
  }
  return nextThreadId
}

function threadModeOverrides(
  collaborationMode: CodexCollaborationMode,
): Record<string, unknown> {
  void collaborationMode
  return {}
}

type CollaborationModeSettings = {
  model?: string | null
  reasoningEffort?: CodexReasoningEffort | null
}

function turnModeOverrides(
  collaborationMode: CodexCollaborationMode,
  settings: CollaborationModeSettings | null = null,
  permissionMode: CodexPermissionMode = "default",
): Record<string, unknown> {
  return {
    approvalPolicy: permissionMode === "fullAccess" ? "never" : null,
    collaborationMode: collaborationModePayload(collaborationMode, settings),
    sandboxPolicy:
      permissionMode === "fullAccess" ? { type: "dangerFullAccess" } : null,
  }
}

function turnSteerModeOverrides(
  collaborationMode: CodexCollaborationMode,
  settings: CollaborationModeSettings | null = null,
): Record<string, unknown> {
  if (collaborationMode !== "plan") {
    return {}
  }
  return { collaborationMode: collaborationModePayload(collaborationMode, settings) }
}

function collaborationModePayload(
  collaborationMode: CodexCollaborationMode,
  settings: CollaborationModeSettings | null = null,
): Record<string, unknown> {
  return {
    mode: collaborationMode,
    ...(settings?.model
      ? {
          settings: {
            developer_instructions: null,
            model: settings.model,
            reasoning_effort: settings.reasoningEffort ?? null,
          },
        }
      : {}),
  }
}

async function resolveCollaborationModeSettings(
  runtime: Pick<CodexRuntimeSession, "request">,
  model: string | null,
  reasoningEffort: CodexReasoningEffort | null,
): Promise<CollaborationModeSettings | null> {
  const selectedModel = normalizeNonEmptyString(model)
  if (selectedModel) {
    return { model: selectedModel, reasoningEffort }
  }

  let resolvedReasoningEffort = reasoningEffort
  try {
    const configResponse = await runtime.request("config/read", {}, 30_000)
    const config = asJsonObject(asJsonObject(configResponse.result)?.config)
    const configuredModel = normalizeNonEmptyString(readString(config?.model))
    resolvedReasoningEffort =
      resolvedReasoningEffort ??
      readReasoningEffort(config?.model_reasoning_effort) ??
      readReasoningEffort(config?.modelReasoningEffort)
    if (configuredModel) {
      return { model: configuredModel, reasoningEffort: resolvedReasoningEffort }
    }
  } catch {
    // Fall back to model/list below. Older runtimes may not expose config/read.
  }

  try {
    const modelResponse = await runtime.request(
      "model/list",
      { includeHidden: false, limit: 100 },
      30_000,
    )
    const result = asJsonObject(modelResponse.result)
    const rows = Array.isArray(result?.data) ? result.data : []
    for (const row of rows) {
      const modelRecord = asJsonObject(row)
      const candidate =
        normalizeNonEmptyString(readString(modelRecord?.id)) ??
        normalizeNonEmptyString(readString(modelRecord?.model))
      if (candidate) {
        return { model: candidate, reasoningEffort: resolvedReasoningEffort }
      }
    }
  } catch {
    // If settings cannot be resolved, still send the native mode without settings.
  }

  return null
}

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function readReasoningEffort(value: unknown): CodexReasoningEffort | null {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value
  }
  return null
}

async function nextSequence(chatId: string): Promise<number> {
  const aggregate = await prisma.chatMessage.aggregate({
    where: { chatId },
    _max: { sequence: true },
  })
  return (aggregate._max.sequence ?? 0) + 1
}

function emit<TType extends ChatEventType>(
  chatId: string,
  type: TType,
  payload: ChatEventPayloads[TType],
): void {
  publishChatEvent(chatId, type, payload)
}

function logProjectionError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.stack ?? error.message : error)
}

type ProjectCodexEventContext = {
  assistantMessageId: string
  chatId: string
  runId: string
  streamBuffers: Map<string, string>
  onAssistantContent: (content: string) => void
}

type ProjectCodexRequestContext = {
  chatId: string
  permissionMode: () => CodexPermissionMode
  runId: string
  runtime: CodexRuntimeSession
}

async function projectCodexEvent(
  context: ProjectCodexEventContext,
  event: CodexJsonRpcResponse,
): Promise<void> {
  const contextUsage = extractContextWindowUsage(event)
  if (contextUsage) {
    emit(context.chatId, "context.updated", contextUsage)
  }
  if (isContextWindowUsageEvent(event)) {
    return
  }
  if (isCompactionEvent(event)) {
    await upsertTimelineMessage({
      chatId: context.chatId,
      completedAt: new Date(),
      content: compactionEventMessage(event),
      itemId: `context-compaction:${eventTurnId(event) ?? event.method ?? Date.now()}`,
      kind: "TOOL_ACTIVITY",
      metadata: {
        kind: "contextCompaction",
        rawMethod: event.method,
      },
      rawPayload: event,
      role: "SYSTEM",
      runId: context.runId,
      status: compactionEventIsStarted(event) ? "STREAMING" : "COMPLETED",
      turnId: eventTurnId(event),
    })
    return
  }

  const method = event.method ?? ""
  const params = asJsonObject(event.params)
  const item = extractItemObject(event)
  const itemType = normalizedType(readString(item?.type) ?? "")

  if (method === "thread/name/updated") {
    const title = extractThreadName(event)
    if (title) {
      await updateChatTitleFromCodex(context.chatId, title)
    }
    return
  }

  if (method === "item/agentMessage/delta" || method.includes("agent_message_delta")) {
    const delta = readText(params?.delta) ?? readText(asJsonObject(params?.event)?.delta)
    if (!delta) {
      return
    }
    const itemId = eventItemId(event) ?? "assistant"
    const nextContent = `${context.streamBuffers.get(itemId) ?? ""}${delta}`
    context.streamBuffers.set(itemId, nextContent)
    context.onAssistantContent(nextContent)
    const response = await upsertTimelineMessage({
      chatId: context.chatId,
      content: nextContent,
      fallbackMessageId: context.assistantMessageId,
      itemId,
      kind: "CHAT",
      metadata: { kind: "assistant", phase: readString(params?.phase) },
      rawPayload: event,
      role: "ASSISTANT",
      runId: context.runId,
      status: "STREAMING",
      turnId: eventTurnId(event),
    })
    emit(context.chatId, "message.delta", {
      content: nextContent,
      delta,
      messageId: response.id,
      runId: context.runId,
    })
    return
  }

  if (method === "item/started" && isAssistantItem(itemType)) {
    await upsertTimelineMessage({
      chatId: context.chatId,
      content: "",
      fallbackMessageId: context.assistantMessageId,
      itemId: eventItemId(event),
      kind: "CHAT",
      metadata: { kind: "assistant", phase: readString(item?.phase) },
      rawPayload: event,
      role: "ASSISTANT",
      runId: context.runId,
      status: "STREAMING",
      turnId: eventTurnId(event),
    })
    return
  }

  if (method === "item/completed" && isAssistantItem(itemType)) {
    const text = extractIncomingMessageText(item) || extractAssistantText(event)
    if (!text) {
      return
    }
    const itemId = eventItemId(event) ?? "assistant"
    context.streamBuffers.set(itemId, text)
    context.onAssistantContent(text)
    await upsertTimelineMessage({
      chatId: context.chatId,
      completedAt: new Date(),
      content: text,
      fallbackMessageId: context.assistantMessageId,
      itemId,
      kind: "CHAT",
      metadata: { kind: "assistant", phase: readString(item?.phase) },
      rawPayload: event,
      role: "ASSISTANT",
      runId: context.runId,
      status: "COMPLETED",
      turnId: eventTurnId(event),
    })
    return
  }

  if (
    method.startsWith("item/reasoning/") ||
    normalizedType(itemType).includes("reasoning")
  ) {
    await appendSystemDelta(context, event, "THINKING", {
      content: extractReasoningText(event, item),
      delta: eventTextDelta(event),
      metadata: { kind: "thinking", status: itemStatus(item, method) },
    })
    return
  }

  if (method === "turn/plan/updated" || method === "item/plan/delta") {
    await projectPlanEvent(context, event)
    return
  }

  if (itemType === "commandexecution" || method.includes("commandExecution")) {
    await projectCommandEvent(context, event, item)
    return
  }

  if (
    itemType === "filechange" ||
    method.includes("fileChange") ||
    method === "turn/diff/updated" ||
    method.includes("turn_diff")
  ) {
    await projectFileChangeEvent(context, event, item)
    return
  }

  if (method === "serverRequest/resolved") {
    await markServerRequestResolved(context.chatId, event)
    return
  }

  if (method === "error" || method === "turn/failed" || method.endsWith("/error")) {
    await projectErrorEvent(context, event)
  }
}

async function projectCodexServerRequest(
  context: ProjectCodexRequestContext,
  request: CodexJsonRpcResponse,
): Promise<void> {
  const method = request.method ?? ""
  if (request.id === undefined || request.id === null) {
    return
  }
  const params = asJsonObject(request.params) ?? {}
  const requestId = jsonRpcIdKey(request.id)
  const requestKind = requestMethodKind(method)
  if (!requestKind) {
    context.runtime.rejectServerRequest(
      request.id,
      -32601,
      `Unsupported request method: ${method}`,
    )
    return
  }

  const metadata = requestKind === "userInput"
    ? userInputMetadata(method, requestId, params, request)
    : approvalMetadata(method, requestId, params, requestKind, request)
  if (context.permissionMode() === "fullAccess" && requestKind !== "userInput") {
    const result = fullAccessServerRequestResult(requestKind)
    context.runtime.respondToServerRequest(request.id, result)
    await upsertTimelineMessage({
      chatId: context.chatId,
      completedAt: new Date(),
      content: serverRequestContent(metadata),
      kind: "APPROVAL",
      metadata: {
        ...metadata,
        autoApproved: true,
        decision: requestKind === "approval" ? "acceptForSession" : undefined,
        result,
        resolvedAt: new Date().toISOString(),
        status: "resolved",
      },
      rawPayload: request,
      requestId,
      role: "SYSTEM",
      runId: context.runId,
      status: "COMPLETED",
      turnId: readString(params.turnId),
      itemId: readString(params.itemId),
    })
    return
  }
  const message = await upsertTimelineMessage({
    chatId: context.chatId,
    content: serverRequestContent(metadata),
    kind: requestKind === "userInput" ? "USER_INPUT_PROMPT" : "APPROVAL",
    metadata,
    rawPayload: request,
    requestId,
    role: "SYSTEM",
    runId: context.runId,
    status: "PENDING",
    turnId: readString(params.turnId),
    itemId: readString(params.itemId),
  })

  pendingServerRequests.set(serverRequestKey(context.chatId, requestId), {
    chatId: context.chatId,
    messageId: message.id,
    requestKind,
    requestId,
    rpcId: request.id,
    runtime: context.runtime,
  })
}

async function appendSystemDelta(
  context: ProjectCodexEventContext,
  event: CodexJsonRpcResponse,
  kind: ChatMessageResponse["kind"],
  options: {
    content?: string
    contentFallback?: string
    delta?: string
    metadata: JsonObject
  },
): Promise<void> {
  const itemId = eventItemId(event) ?? `${kind.toLowerCase()}:${eventTurnId(event) ?? "turn"}`
  const bufferKey = `${kind}:${itemId}`
  const bufferedContent = context.streamBuffers.get(bufferKey)
  const nextContent = options.delta
    ? `${bufferedContent ?? ""}${options.delta}`
    : options.content ?? bufferedContent ?? options.contentFallback ?? ""
  if (!nextContent.trim()) {
    return
  }
  context.streamBuffers.set(bufferKey, nextContent)
  await upsertTimelineMessage({
    chatId: context.chatId,
    content: nextContent,
    itemId,
    kind,
    metadata: options.metadata,
    rawPayload: event,
    role: "SYSTEM",
    runId: context.runId,
    status: eventIsCompleted(event) ? "COMPLETED" : "STREAMING",
    turnId: eventTurnId(event),
  })
}

async function projectPlanEvent(
  context: ProjectCodexEventContext,
  event: CodexJsonRpcResponse,
): Promise<void> {
  const params = asJsonObject(event.params) ?? {}
  const delta = event.method === "item/plan/delta" ? eventTextDelta(event) : undefined
  const plan = Array.isArray(params.plan) ? params.plan : []
  const steps = plan
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => !!entry)
    .map((entry) => ({
      status: readString(entry.status) ?? "pending",
      step: readString(entry.step) ?? "",
    }))
    .filter((entry) => entry.step)
  const explanation = readString(params.explanation)
  const turnId = eventTurnId(event)
  const itemId =
    event.method === "turn/plan/updated"
      ? `plan:${turnId ?? context.runId}`
      : eventItemId(event) ?? `plan:${turnId ?? context.runId}`
  const bufferKey = `PLAN:${itemId}`
  const content = delta
    ? `${context.streamBuffers.get(bufferKey) ?? ""}${delta}`
    : explanation ?? steps.map((step) => step.step).join("\n")
  if (!content.trim() && !steps.length && !explanation) {
    return
  }
  context.streamBuffers.set(bufferKey, content)
  await upsertTimelineMessage({
    chatId: context.chatId,
    content,
    itemId,
    kind: "PLAN",
    metadata: {
      explanation,
      kind: "plan",
      presentation: delta ? "result" : "progress",
      steps,
    },
    rawPayload: event,
    role: "SYSTEM",
    runId: context.runId,
    status: event.method === "item/plan/delta" ? "STREAMING" : "COMPLETED",
    turnId,
  })
}

async function projectCommandEvent(
  context: ProjectCodexEventContext,
  event: CodexJsonRpcResponse,
  item?: JsonObject,
): Promise<void> {
  const params = asJsonObject(event.params) ?? {}
  const payload = item ?? params
  const itemId = eventItemId(event) ?? `command:${eventTurnId(event) ?? "turn"}`
  const bufferKey = `COMMAND:${itemId}`
  const delta = eventTextDelta(event)
  const output = delta
    ? `${context.streamBuffers.get(bufferKey) ?? ""}${delta}`
    : readText(payload.output) ??
      readText(payload.aggregatedOutput) ??
      readText(payload.aggregated_output) ??
      context.streamBuffers.get(bufferKey) ??
      ""
  context.streamBuffers.set(bufferKey, output)
  const command = readString(payload.command) ?? readString(params.command) ?? "command"
  const status = itemStatus(payload, event.method ?? "")
  await upsertTimelineMessage({
    chatId: context.chatId,
    completedAt: eventIsCompleted(event) ? new Date() : undefined,
    content: command,
    itemId,
    kind: "COMMAND_EXECUTION",
    metadata: {
      actions: readJsonArray(payload.actions) ?? readJsonArray(payload.commandActions),
      command,
      cwd: readString(payload.cwd) ?? readString(params.cwd),
      durationMs: readNumber(payload.durationMs) ?? readNumber(payload.duration_ms),
      exitCode: readNumber(payload.exitCode) ?? readNumber(payload.exit_code),
      kind: "command",
      output,
      status,
    },
    rawPayload: event,
    role: "SYSTEM",
    runId: context.runId,
    status: status === "failed" ? "FAILED" : eventIsCompleted(event) ? "COMPLETED" : "STREAMING",
    turnId: eventTurnId(event),
  })
}

async function projectFileChangeEvent(
  context: ProjectCodexEventContext,
  event: CodexJsonRpcResponse,
  item?: JsonObject,
): Promise<void> {
  const params = asJsonObject(event.params) ?? {}
  const payload = item ?? params
  const itemId = eventItemId(event) ?? `file-change:${eventTurnId(event) ?? "turn"}`
  const diff = extractDiffText(payload) ?? extractDiffText(params)
  const changes = readJsonArray(payload.changes) ?? readJsonArray(params.changes) ?? []
  const paths = extractChangedPaths(payload, changes)
  await upsertTimelineMessage({
    chatId: context.chatId,
    content: paths.length ? paths.join("\n") : "File changes",
    itemId,
    kind: "FILE_CHANGE",
    metadata: {
      additions: readNumber(payload.additions) ?? countDiffLines(diff, "+"),
      changes,
      deletions: readNumber(payload.deletions) ?? countDiffLines(diff, "-"),
      diff,
      kind: "fileChange",
      paths,
      status: itemStatus(payload, event.method ?? ""),
    },
    rawPayload: event,
    role: "SYSTEM",
    runId: context.runId,
    status: eventIsCompleted(event) ? "COMPLETED" : "STREAMING",
    turnId: eventTurnId(event),
  })
}

async function projectErrorEvent(
  context: ProjectCodexEventContext,
  event: CodexJsonRpcResponse,
): Promise<void> {
  const params = asJsonObject(event.params)
  const error = asJsonObject(params?.error)
  const message =
    readString(error?.message) ??
    readString(params?.message) ??
    event.error?.message ??
    "Codex runtime error."
  await upsertTimelineMessage({
    chatId: context.chatId,
    completedAt: new Date(),
    content: message,
    itemId: `error:${eventTurnId(event) ?? Date.now()}`,
    kind: "ERROR",
    metadata: {
      details: toSerializable(event),
      kind: "error",
      message,
    },
    rawPayload: event,
    role: "SYSTEM",
    runId: context.runId,
    status: "FAILED",
    turnId: eventTurnId(event),
  })
}

async function upsertTimelineMessage(input: {
  chatId: string
  completedAt?: Date
  content: string
  fallbackMessageId?: string
  itemId?: string | null
  kind: ChatMessageResponse["kind"]
  metadata?: unknown
  rawPayload?: unknown
  requestId?: string | null
  role: ChatMessageResponse["role"]
  runId: string
  status: ChatMessageResponse["status"]
  turnId?: string | null
}): Promise<ChatMessageResponse> {
  return withTimelineMessageLock(timelineMessageLockKey(input), async () => {
    const existing = await findTimelineMessage(input)
    const data: Omit<Prisma.ChatMessageUncheckedCreateInput, "chatId" | "sequence"> = {
      completedAt: input.completedAt,
      content: input.content,
      itemId: input.itemId ?? undefined,
      kind: input.kind,
      metadata: input.metadata === undefined ? undefined : toJsonInput(input.metadata),
      rawPayload: input.rawPayload === undefined ? undefined : toJsonInput(input.rawPayload),
      requestId: input.requestId ?? undefined,
      role: input.role,
      runId: input.runId,
      status: input.status,
      turnId: input.turnId ?? undefined,
    }
    const message = existing
      ? await prisma.chatMessage.update({
          where: { id: existing.id },
          data,
        })
      : await createSequencedChatMessage(input.chatId, data)
    const response = toChatMessageResponse(message)
    emit(input.chatId, existing ? "message.updated" : "message.created", response)
    return response
  })
}

function timelineMessageLockKey(input: {
  chatId: string
  fallbackMessageId?: string
  itemId?: string | null
  kind: ChatMessageResponse["kind"]
  requestId?: string | null
}): string | null {
  if (input.requestId) {
    return `${input.chatId}:request:${input.requestId}`
  }
  if (input.itemId) {
    return `${input.chatId}:item:${input.kind}:${input.itemId}`
  }
  if (input.fallbackMessageId) {
    return `${input.chatId}:fallback:${input.fallbackMessageId}`
  }
  return null
}

async function findTimelineMessage(input: {
  chatId: string
  fallbackMessageId?: string
  itemId?: string | null
  kind: ChatMessageResponse["kind"]
  requestId?: string | null
}) {
  if (input.requestId) {
    const byRequest = await prisma.chatMessage.findFirst({
      where: { chatId: input.chatId, requestId: input.requestId },
      orderBy: { sequence: "desc" },
    })
    if (byRequest) {
      return byRequest
    }
  }
  if (input.itemId) {
    const byItem = await prisma.chatMessage.findFirst({
      where: { chatId: input.chatId, itemId: input.itemId, kind: input.kind },
      orderBy: { sequence: "desc" },
    })
    if (byItem) {
      return byItem
    }
  }
  if (input.fallbackMessageId) {
    const fallback = await prisma.chatMessage.findUnique({
      where: { id: input.fallbackMessageId },
    })
    if (!fallback) {
      return null
    }
    if (!input.itemId || !fallback.itemId || fallback.itemId === input.itemId) {
      return fallback
    }
  }
  return null
}

function extractAssistantText(message: CodexJsonRpcResponse): string {
  const result = asJsonObject(message.result)
  const params = asJsonObject(message.params)
  const payload = asJsonObject(params?.payload) ?? params ?? result
  const turn = asJsonObject(params?.turn) ?? asJsonObject(result?.turn)
  const turnText = extractTurnAssistantText(turn)
  return (
    turnText ??
    readText(result?.text) ??
    readText(result?.content) ??
    readText(payload?.text) ??
    readText(payload?.content) ??
    readText(payload?.delta) ??
    readText(payload?.message) ??
    ""
  )
}

function getTurnId(message: CodexJsonRpcResponse): string | undefined {
  const result = asJsonObject(message.result)
  const params = asJsonObject(message.params)
  return (
    readString(result?.turnId) ??
    readString(result?.turn_id) ??
    readString(params?.turnId) ??
    readString(params?.turn_id) ??
    readString(asJsonObject(result?.turn)?.id) ??
    readString(asJsonObject(params?.turn)?.id)
  )
}

function extractTurnAssistantText(
  turn?: Record<string, unknown>,
): string | null {
  const items = Array.isArray(turn?.items) ? turn.items : []
  const texts = items
    .map((item) => {
      const object = asJsonObject(item)
      if (object?.type !== "agentMessage") {
        return null
      }
      return readText(object.text) ?? null
    })
    .filter((text): text is string => !!text)
  return texts.length ? texts.join("\n\n") : null
}

async function readLatestAssistantText(
  runtime: {
    request(
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<CodexJsonRpcResponse>
  },
  threadId: string,
  turnId?: string,
): Promise<string | null> {
  try {
    const response = await runtime.request(
      "thread/turns/list",
      { threadId, limit: 20 },
      30_000,
    )
    const result = asJsonObject(response.result)
    const turns = Array.isArray(result?.data) ? result.data : []
    const matchingTurns = turns
      .map((turn) => asJsonObject(turn))
      .filter((turn): turn is Record<string, unknown> => !!turn)
      .filter((turn) => !turnId || readString(turn.id) === turnId)
    const turn = matchingTurns.at(-1)
    return extractTurnAssistantText(turn) ?? null
  } catch {
    return null
  }
}

function eventBelongsToTurn(
  event: CodexJsonRpcResponse,
  threadId: string | null,
  turnId?: string,
): boolean {
  const eventThreadId = readEventThreadId(event)
  if (threadId && eventThreadId && eventThreadId !== threadId) {
    return false
  }
  const eventTurn = eventTurnId(event)
  if (turnId && eventTurn && eventTurn !== turnId) {
    return false
  }
  return true
}

function serverRequestBelongsToTurn(
  request: CodexJsonRpcResponse,
  threadId: string | null,
  turnId?: string,
): boolean {
  const params = asJsonObject(request.params)
  const requestThreadId = readString(params?.threadId)
  if (threadId && requestThreadId && requestThreadId !== threadId) {
    return false
  }
  const requestTurnId = readString(params?.turnId)
  if (turnId && requestTurnId && requestTurnId !== turnId) {
    return false
  }
  return true
}

function readEventThreadId(event: CodexJsonRpcResponse): string | undefined {
  const params = asJsonObject(event.params)
  const result = asJsonObject(event.result)
  const eventObject = asJsonObject(params?.event)
  return (
    readString(params?.threadId) ??
    readString(params?.thread_id) ??
    readString(result?.threadId) ??
    readString(result?.thread_id) ??
    readString(eventObject?.threadId) ??
    readString(eventObject?.thread_id)
  )
}

function eventTurnId(event: CodexJsonRpcResponse): string | undefined {
  const params = asJsonObject(event.params)
  const result = asJsonObject(event.result)
  const item = extractItemObject(event)
  return (
    readString(params?.turnId) ??
    readString(result?.turnId) ??
    readString(item?.turnId) ??
    getTurnId(event)
  )
}

function eventItemId(event: CodexJsonRpcResponse): string | undefined {
  const params = asJsonObject(event.params)
  const result = asJsonObject(event.result)
  const item = extractItemObject(event)
  return (
    readString(params?.itemId) ??
    readString(result?.itemId) ??
    readString(item?.id)
  )
}

function extractItemObject(event: CodexJsonRpcResponse): JsonObject | undefined {
  const params = asJsonObject(event.params)
  const result = asJsonObject(event.result)
  const payload = asJsonObject(params?.payload)
  return (
    asJsonObject(params?.item) ??
    asJsonObject(result?.item) ??
    asJsonObject(payload?.item)
  )
}

function extractIncomingMessageText(item?: JsonObject): string {
  if (!item) {
    return ""
  }
  const direct = readText(item.text) ?? readText(item.content)
  if (direct) {
    return direct
  }
  const content = Array.isArray(item.content) ? item.content : []
  return content
    .map((entry) => {
      const object = asJsonObject(entry)
      return readText(object?.text) ?? ""
    })
    .filter(Boolean)
    .join("")
}

function eventTextDelta(event: CodexJsonRpcResponse): string | undefined {
  const params = asJsonObject(event.params)
  const eventObject = asJsonObject(params?.event)
  return (
    readText(params?.delta) ??
    readText(params?.text) ??
    readText(params?.output) ??
    readText(eventObject?.delta) ??
    readText(eventObject?.text)
  )
}

function extractReasoningText(
  event: CodexJsonRpcResponse,
  item?: JsonObject,
): string | undefined {
  const params = asJsonObject(event.params)
  const result = asJsonObject(event.result)
  const eventObject = asJsonObject(params?.event)
  const payload = asJsonObject(params?.payload)
  return [item, params, eventObject, payload, result]
    .map(readReasoningTextFromObject)
    .find((text): text is string => !!text?.trim())
}

function readReasoningTextFromObject(object?: JsonObject): string | undefined {
  if (!object) {
    return undefined
  }
  return (
    readText(object.reasoning) ??
    readText(object.reasoningText) ??
    readText(object.reasoning_text) ??
    readText(object.summary) ??
    readContentText(object.summary) ??
    readContentText(object.content) ??
    readText(object.text) ??
    readText(object.output)
  )
}

function normalizedType(value: string): string {
  return value.toLowerCase().replaceAll("_", "").replaceAll("-", "")
}

function isAssistantItem(itemType: string): boolean {
  return (
    itemType === "agentmessage" ||
    itemType === "assistantmessage" ||
    itemType === "exitedreviewmode" ||
    itemType === "message"
  )
}

function eventIsCompleted(event: CodexJsonRpcResponse): boolean {
  const method = event.method ?? ""
  return (
    method.includes("completed") ||
    method.includes("finished") ||
    method.includes("done") ||
    method.endsWith("/end")
  )
}

function turnEventIsTerminal(event: CodexJsonRpcResponse): boolean {
  const method = event.method ?? ""
  return (
    method === "turn/completed" ||
    method === "turn/failed" ||
    method === "turn/interrupted" ||
    method === "turn/cancelled" ||
    method === "turn/canceled" ||
    (method.startsWith("turn/") &&
      (method.includes("completed") ||
        method.includes("failed") ||
        method.includes("interrupted") ||
        method.includes("cancelled") ||
        method.includes("canceled")))
  )
}

function turnEventIsFailure(event: CodexJsonRpcResponse): boolean {
  const method = event.method ?? ""
  return (
    method.includes("failed") ||
    method.includes("cancelled") ||
    method.includes("canceled")
  )
}

function turnEventIsInterrupted(event: CodexJsonRpcResponse): boolean {
  const method = event.method ?? ""
  return (
    method.includes("interrupted") ||
    method.includes("cancelled") ||
    method.includes("canceled")
  )
}

function terminalTurnMessage(event: CodexJsonRpcResponse): string {
  const params = asJsonObject(event.params)
  const error = asJsonObject(params?.error)
  return (
    readString(error?.message) ??
    readString(params?.message) ??
    (event.method?.includes("interrupt")
      ? "Codex turn was interrupted."
      : "Codex turn failed.")
  )
}

function itemStatus(payload: JsonObject | undefined, method: string): string {
  const status = readString(payload?.status)
  if (status) {
    return normalizedType(status)
  }
  if (method.includes("failed") || method.includes("error")) {
    return "failed"
  }
  if (eventIsCompleted({ method })) {
    return "completed"
  }
  return "running"
}

function extractDiffText(payload: JsonObject): string | undefined {
  return (
    readText(payload.diff) ??
    readText(payload.unifiedDiff) ??
    readText(payload.unified_diff) ??
    readText(payload.patch)
  )
}

function extractChangedPaths(payload: JsonObject, changes: JsonSerializable[]): string[] {
  const candidates = [
    readString(payload.path),
    readString(payload.filePath),
    readString(payload.file_path),
    ...changes.flatMap((change) => {
      const object = asJsonObject(change)
      return [
        readString(object?.path),
        readString(object?.filePath),
        readString(object?.file_path),
      ]
    }),
  ].filter((path): path is string => !!path)
  return [...new Set(candidates)]
}

function countDiffLines(diff: string | undefined, prefix: "+" | "-"): number {
  if (!diff) {
    return 0
  }
  return diff
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length
}

function readJsonArray(value: unknown): JsonSerializable[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.map(toSerializable)
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function extractContextWindowUsage(
  event: CodexJsonRpcResponse,
): ContextWindowUsagePayload | null {
  const payload = findTokenCountPayload(event)
  if (payload) {
    const params = asJsonObject(payload.params)
    const info =
      asJsonObject(payload.info) ??
      asJsonObject(params?.info) ??
      params ??
      payload
    const preferredUsage =
      firstJsonObject(info, ["last_token_usage", "lastTokenUsage"]) ??
      firstJsonObject(info, ["total_token_usage", "totalTokenUsage"])
    return contextWindowUsageFromObject(preferredUsage ?? info, info)
  }

  const params = asJsonObject(event.params)
  const eventObject = asJsonObject(params?.event)
  const usageObject =
    asJsonObject(params?.usage) ??
    asJsonObject(eventObject?.usage) ??
    (contextWindowUsageMethod(event.method) ? params : undefined)
  return usageObject ? contextWindowUsageFromObject(usageObject) : null
}

function isContextWindowUsageEvent(event: CodexJsonRpcResponse): boolean {
  return !!findTokenCountPayload(event) || contextWindowUsageMethod(event.method)
}

function isCompactionEvent(event: CodexJsonRpcResponse): boolean {
  const params = asJsonObject(event.params)
  const payload = asJsonObject(params?.payload) ?? asJsonObject(params?.event)
  const candidates = [
    event.method,
    readString(params?.type),
    readString(payload?.type),
    readString(payload?.event),
  ]
  return candidates.some((candidate) =>
    normalizedType(candidate ?? "").includes("compact"),
  )
}

function compactionEventMessage(event: CodexJsonRpcResponse): string {
  const normalized = normalizedType(event.method ?? "")
  if (normalized.includes("start")) {
    return "Context compaction started."
  }
  if (normalized.includes("finish") || normalized.includes("complete")) {
    return "Context compacted."
  }
  return "Context compaction recorded."
}

function compactionEventIsStarted(event: CodexJsonRpcResponse): boolean {
  return normalizedType(event.method ?? "").includes("start")
}

function contextWindowUsageMethod(method: string | undefined): boolean {
  const normalized = normalizedType(method ?? "")
  return (
    normalized === "threadtokenusageupdated" ||
    normalized.includes("tokenusage") ||
    normalized.includes("contextusage") ||
    normalized.includes("contextwindow")
  )
}

function contextWindowUsageFromObject(
  usageRoot: JsonObject,
  limitRoot = usageRoot,
): ContextWindowUsagePayload | null {
  const tokenLimit = firstPositiveInteger(limitRoot, [
    "model_context_window",
    "modelContextWindow",
    "context_window",
    "contextWindow",
    "contextSize",
    "context_size",
    "inputTokenLimit",
    "input_token_limit",
    "maxContextTokens",
    "max_context_tokens",
    "maxInputTokens",
    "max_input_tokens",
    "maxTokens",
    "max_tokens",
    "tokenLimit",
    "token_limit",
  ])
  const explicitTotal = firstPositiveInteger(usageRoot, [
    "total_tokens",
    "totalTokens",
    "tokens_used",
    "tokensUsed",
    "used_tokens",
    "usedTokens",
    "input_tokens",
    "inputTokens",
  ])
  const tokensRemaining = firstPositiveInteger(usageRoot, [
    "remaining_input_tokens",
    "remainingInputTokens",
    "remaining_tokens",
    "remainingTokens",
    "tokens_remaining",
    "tokensRemaining",
  ])
  const resolvedTokenLimit =
    tokenLimit ??
    (explicitTotal !== undefined && tokensRemaining !== undefined
      ? explicitTotal + tokensRemaining
      : undefined)
  if (!resolvedTokenLimit) {
    return null
  }

  const summedTotal = sumPositiveIntegers([
    firstPositiveInteger(usageRoot, ["input_tokens", "inputTokens"]),
    firstPositiveInteger(usageRoot, ["output_tokens", "outputTokens"]),
    firstPositiveInteger(usageRoot, [
      "reasoning_output_tokens",
      "reasoningOutputTokens",
    ]),
  ])
  const rawTokensUsed = explicitTotal ?? summedTotal
  if (rawTokensUsed === null) {
    return null
  }

  const tokensUsed = Math.min(rawTokensUsed, resolvedTokenLimit)
  const remainingTokens = Math.max(0, resolvedTokenLimit - tokensUsed)
  const usedPercent = Math.max(
    0,
    Math.min(100, Math.round((tokensUsed / resolvedTokenLimit) * 100)),
  )
  return {
    tokenLimit: resolvedTokenLimit,
    tokensRemaining: remainingTokens,
    tokensUsed,
    remainingPercent: Math.max(0, 100 - usedPercent),
    usedPercent,
  }
}

function findTokenCountPayload(value: unknown, depth = 0): JsonObject | undefined {
  if (depth > 4) {
    return undefined
  }
  const object = asJsonObject(value)
  if (!object) {
    return undefined
  }

  const type = normalizedType(readString(object.type) ?? "")
  const method = normalizedType(readString(object.method) ?? "")
  if (type === "tokencount" || method === "tokencount") {
    return object
  }

  for (const key of ["payload", "event", "params", "message"]) {
    const nested = findTokenCountPayload(object[key], depth + 1)
    if (nested) {
      return nested
    }
  }

  return undefined
}

function firstJsonObject(
  object: JsonObject,
  keys: string[],
): JsonObject | undefined {
  for (const key of keys) {
    const value = asJsonObject(object[key])
    if (value) {
      return value
    }
  }
  return undefined
}

function firstPositiveInteger(
  object: JsonObject,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = readPositiveInteger(object[key])
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

function sumPositiveIntegers(values: Array<number | undefined>): number | null {
  let found = false
  let total = 0
  for (const value of values) {
    if (value === undefined) {
      continue
    }
    found = true
    total += value
  }
  return found ? total : null
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed)
    }
  }
  return undefined
}

function requestMethodKind(
  method: string,
): "approval" | "permissions" | "userInput" | null {
  if (method === "tool/requestUserInput" || method === "item/tool/requestUserInput") {
    return "userInput"
  }
  if (method.includes("requestApproval")) {
    return normalizedType(method).includes("permissions") ? "permissions" : "approval"
  }
  if (normalizedType(method).includes("elicitation")) {
    return "userInput"
  }
  return null
}

function approvalMetadata(
  method: string,
  requestId: string,
  params: JsonObject,
  requestKind: "approval" | "permissions",
  request: CodexJsonRpcResponse,
) {
  return {
    availableDecisions: readJsonArray(params.availableDecisions),
    changes: readJsonArray(params.changes),
    command: readString(params.command),
    cwd: readString(params.cwd),
    itemId: readString(params.itemId),
    kind: requestKind,
    method,
    raw: toSerializable(request),
    reason: readString(params.reason) ?? readString(params.message),
    requestId,
    requestKind,
    status: "pending",
    turnId: readString(params.turnId),
  }
}

function userInputMetadata(
  method: string,
  requestId: string,
  params: JsonObject,
  request: CodexJsonRpcResponse,
) {
  return {
    kind: "userInput",
    message: readString(params.message),
    method,
    mode: readString(params.mode),
    questions: decodeUserInputQuestions(params.questions),
    raw: toSerializable(request),
    requestId,
    status: "pending",
  }
}

function decodeUserInputQuestions(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => !!entry)
    .map((entry) => ({
      header: readString(entry.header),
      id: readString(entry.id) ?? randomUUID(),
      isOther: typeof entry.isOther === "boolean" ? entry.isOther : undefined,
      isSecret: typeof entry.isSecret === "boolean" ? entry.isSecret : undefined,
      options: decodeUserInputOptions(entry.options),
      question: readString(entry.question) ?? readString(entry.header) ?? "Answer",
      selectionLimit: readNumber(entry.selectionLimit) ?? readNumber(entry.selection_limit),
    }))
}

function decodeUserInputOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => !!entry)
    .map((entry) => ({
      description: readString(entry.description),
      label: readString(entry.label) ?? readString(entry.value) ?? "",
    }))
    .filter((entry) => entry.label)
}

function serverRequestContent(metadata: JsonObject): string {
  if (metadata.kind === "userInput") {
    return (
      readString(metadata.message) ??
      "Codex needs more information before it can continue."
    )
  }
  return (
    readString(metadata.reason) ??
    readString(metadata.command) ??
    "Codex needs approval before it can continue."
  )
}

function serverRequestResult(
  dto: ServerRequestResponseRequest,
): JsonSerializable {
  if (dto.kind === "approval") {
    if (dto.decision === undefined) {
      throw new HttpError(400, "decision is required for approval requests.")
    }
    return { decision: dto.decision }
  }
  if (dto.kind === "permissions") {
    if (dto.result === undefined) {
      throw new HttpError(400, "result is required for permissions requests.")
    }
    return dto.result
  }
  if (dto.result === undefined) {
    throw new HttpError(400, "result is required for user input requests.")
  }
  return dto.result
}

function fullAccessServerRequestResult(
  requestKind: "approval" | "permissions",
): JsonSerializable {
  if (requestKind === "approval") {
    return { decision: "acceptForSession" }
  }
  return { scope: "session", permissions: true }
}

async function markServerRequestResolved(
  chatId: string,
  event: CodexJsonRpcResponse,
): Promise<void> {
  const params = asJsonObject(event.params) ?? {}
  const requestId = readString(params.requestId) ?? readString(params.id)
  if (!requestId) {
    return
  }
  pendingServerRequests.delete(serverRequestKey(chatId, requestId))
  const message = await prisma.chatMessage.findFirst({
    where: { chatId, requestId },
  })
  if (!message) {
    return
  }
  const updated = await prisma.chatMessage.update({
    where: { id: message.id },
    data: {
      completedAt: new Date(),
      metadata: mergeMetadata(message.metadata, {
        result: params.result === undefined ? null : toSerializable(params.result),
        resolvedAt: new Date().toISOString(),
        status: "resolved",
      }),
      status: "COMPLETED",
    },
  })
  emit(chatId, "message.updated", toChatMessageResponse(updated))
}

async function expirePendingServerRequests(
  chatId: string,
  runId: string,
  reason: string,
): Promise<void> {
  const messages = await prisma.chatMessage.findMany({
    where: {
      chatId,
      kind: { in: ["APPROVAL", "USER_INPUT_PROMPT"] },
      runId,
      status: "PENDING",
    },
  })

  for (const message of messages) {
    const metadata = asJsonObject(message.metadata)
    if (metadata?.status === "resolved" || metadata?.status === "expired") {
      continue
    }
    if (message.requestId) {
      const key = serverRequestKey(chatId, message.requestId)
      const pending = pendingServerRequests.get(key)
      pending?.runtime.rejectServerRequest(
        pending.rpcId,
        -32000,
        `Server request expired: ${reason}`,
      )
      pendingServerRequests.delete(key)
    }
    const updated = await prisma.chatMessage.update({
      where: { id: message.id },
      data: {
        completedAt: new Date(),
        metadata: mergeMetadata(message.metadata, {
          expiredAt: new Date().toISOString(),
          reason,
          status: "expired",
        }),
        status: "COMPLETED",
      },
    })
    emit(chatId, "message.updated", toChatMessageResponse(updated))
  }
}

async function settleOpenRunTimelineMessages(
  chatId: string,
  runId: string,
  status: Extract<ChatMessageResponse["status"], "COMPLETED" | "FAILED">,
): Promise<void> {
  const messages = await prisma.chatMessage.findMany({
    where: {
      chatId,
      kind: {
        in: [
          "COMMAND_EXECUTION",
          "FILE_CHANGE",
          "PLAN",
          "THINKING",
          "TOOL_ACTIVITY",
        ],
      },
      runId,
      status: { in: ["PENDING", "STREAMING"] },
    },
  })

  for (const message of messages) {
    const updated = await prisma.chatMessage.update({
      where: { id: message.id },
      data: {
        completedAt: new Date(),
        status,
      },
    })
    emit(chatId, "message.updated", toChatMessageResponse(updated))
  }
}

async function runHasPlanResult(
  chatId: string,
  runId: string,
): Promise<boolean> {
  const messages = await prisma.chatMessage.findMany({
    where: {
      chatId,
      runId,
      OR: [
        { kind: "PLAN" },
        { kind: "CHAT", role: "ASSISTANT" },
      ],
    },
  })

  return messages.some((message) => {
    const content = message.content.trim()
    if (!content || content === "Planning...") {
      return false
    }
    if (message.kind === "CHAT") {
      return /<proposed_plan\b[^>]*>[\s\S]*?<\/proposed_plan>/i.test(content)
    }
    const metadata = asJsonObject(message.metadata)
    return metadata?.presentation === "result"
  })
}

async function messageMetadata(messageId: string): Promise<unknown> {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { metadata: true },
  })
  return message?.metadata ?? null
}

function mergeMetadata(existing: unknown, patch: JsonObject): Prisma.InputJsonValue {
  return toJsonInput({
    ...(asJsonObject(existing) ?? {}),
    ...patch,
  })
}

function serverRequestKey(chatId: string, requestId: string): string {
  return `${chatId}:${requestId}`
}

function toSerializable(value: unknown): JsonSerializable {
  return JSON.parse(JSON.stringify(value)) as JsonSerializable
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function toChatMessageResponse(message: PersistedChatMessage): ChatMessageResponse {
  return {
    ...message,
    metadata: message.metadata as ChatMessageResponse["metadata"],
    rawPayload: message.rawPayload as JsonSerializable | null,
  }
}

function toChatResponse(chat: PersistedChat): ChatResponse {
  return {
    ...chat,
    collaborationMode: normalizeStoredCollaborationMode(chat.collaborationMode),
    permissionMode: normalizeStoredPermissionMode(chat.permissionMode),
    reasoningEffort: chat.reasoningEffort as ChatResponse["reasoningEffort"],
    serviceTier: chat.serviceTier as ChatResponse["serviceTier"],
  }
}

function extractThreadName(event: CodexJsonRpcResponse): string | null {
  if (event.method !== "thread/name/updated") {
    return null
  }
  const params = asJsonObject(event.params)
  const result = asJsonObject(event.result)
  const eventObject = asJsonObject(params?.event)
  return (
    extractThreadTitleFromObject(params) ??
    extractThreadTitleFromObject(eventObject) ??
    extractThreadTitleFromObject(result)
  )
}

function normalizeChatTitle(value: string): string | null {
  const title = value.replace(/\s+/g, " ").trim()
  return title ? title.slice(0, 160) : null
}

function normalizeTitleComparisonValue(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? ""
}

function extractThreadTitleFromObject(value: unknown): string | null {
  const object = asJsonObject(value)
  if (!object) {
    return null
  }
  const candidates = [
    object.threadName,
    object.thread_name,
    object.name,
    object.title,
  ]
  for (const candidate of candidates) {
    const title = normalizeChatTitle(readString(candidate) ?? "")
    if (title) {
      return title
    }
  }
  const thread = asJsonObject(object.thread)
  return thread ? extractThreadTitleFromObject(thread) : null
}

async function refreshChatTitleFromCodex(
  runtime: Pick<CodexRuntimeSession, "request">,
  chatId: string,
  threadId: string | null,
): Promise<void> {
  if (!threadId) {
    return
  }
  const title = await readThreadTitleFromCodex(runtime, threadId)
  if (title) {
    await updateChatTitleFromCodex(chatId, title)
  }
}

function scheduleAutomaticChatTitleIfNeeded({
  chatId,
  cwd,
  runtime,
  seed,
  threadId,
}: {
  chatId: string
  cwd: string
  runtime: Pick<CodexRuntimeSession, "request">
  seed: string | null
  threadId: string
}) {
  const trimmedSeed = seed?.trim()
  if (!trimmedSeed) {
    return
  }
  const fallbackTitle = fallbackChatTitle(trimmedSeed)
  const allowedCurrentTitles = new Set([
    "untitled chat",
    "conversation",
    ...(fallbackTitle ? [normalizeTitleComparisonValue(fallbackTitle)] : []),
  ])

  void (async () => {
    if (fallbackTitle) {
      await applyAutomaticChatTitleIfAllowed(
        runtime,
        chatId,
        threadId,
        fallbackTitle,
        allowedCurrentTitles,
      )
    }
    const generatedTitle = await generatedChatTitleOrNull(runtime, {
      cwd,
      seed: trimmedSeed,
    })
    if (!generatedTitle) {
      return
    }
    await applyAutomaticChatTitleIfAllowed(
      runtime,
      chatId,
      threadId,
      generatedTitle,
      allowedCurrentTitles,
    )
  })().catch(() => undefined)
}

async function generatedChatTitleOrNull(
  runtime: Pick<CodexRuntimeSession, "request">,
  {
    cwd,
    seed,
  }: {
    cwd: string
    seed: string
  },
): Promise<string | null> {
  try {
    const response = await runtime.request(
      "thread/generateTitle",
      {
        cwd,
        message: seed,
      },
      30_000,
    )
    const result = asJsonObject(response.result)
    return normalizeChatTitle(
      readString(result?.title) ??
        readString(result?.name) ??
        readString(result?.threadName) ??
        "",
    )
  } catch {
    return null
  }
}

async function applyAutomaticChatTitleIfAllowed(
  runtime: Pick<CodexRuntimeSession, "request">,
  chatId: string,
  threadId: string,
  title: string,
  allowedCurrentTitles: Set<string>,
): Promise<boolean> {
  const normalizedTitle = normalizeChatTitle(title)
  if (!normalizedTitle) {
    return false
  }

  const chat = await prisma.chat.findUnique({ where: { id: chatId } })
  if (!chat) {
    return false
  }
  const currentTitle = normalizeTitleComparisonValue(chat.title)
  const canReplace =
    isGenericChatTitle(chat.title) || allowedCurrentTitles.has(currentTitle)
  if (!canReplace) {
    return false
  }

  await updateChatTitleFromCodex(chatId, normalizedTitle)
  void sendThreadNameSet(runtime, threadId, normalizedTitle)
  return true
}

async function sendThreadNameSet(
  runtime: Pick<CodexRuntimeSession, "request">,
  threadId: string,
  name: string,
): Promise<void> {
  try {
    await runtime.request(
      "thread/name/set",
      {
        name,
        thread_id: threadId,
        threadId,
      },
      30_000,
    )
  } catch {
    // Local titles should still update when older runtimes do not support this RPC.
  }
}

async function persistChatTitleToCodex(chat: Chat): Promise<void> {
  if (!chat.accountId || !chat.externalThreadId) {
    return
  }
  const account = await prisma.codexAccount.findUnique({
    where: { id: chat.accountId },
  })
  if (!account || account.status !== "CONNECTED") {
    return
  }
  const runtime = codexRuntimeService.getRuntime({
    accountId: account.id,
    command: account.command,
    args: normalizeAccountArgs(account.args),
    workingDirectory: null,
    environment: normalizeEnvironment(account.environment),
  })
  await sendThreadNameSet(runtime, chat.externalThreadId, chat.title)
}

function normalizeAccountArgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ["app-server"]
  }
  return value.filter((entry): entry is string => typeof entry === "string")
}

async function readThreadTitleFromCodex(
  runtime: Pick<CodexRuntimeSession, "request">,
  threadId: string,
): Promise<string | null> {
  try {
    const response = await runtime.request(
      "thread/read",
      { includeTurns: false, threadId },
      30_000,
    )
    const result = asJsonObject(response.result)
    const title = extractThreadTitleFromObject(result)
    if (title) {
      return title
    }
  } catch {
    // Fall back to thread/list for runtimes that do not support thread/read.
  }

  try {
    const response = await runtime.request(
      "thread/list",
      {
        archived: false,
        limit: 100,
        modelProviders: [],
        sortKey: "updated_at",
      },
      30_000,
    )
    const result = asJsonObject(response.result)
    const rows =
      readThreadRows(result?.data) ??
      readThreadRows(result?.items) ??
      readThreadRows(result?.threads) ??
      []
    const thread = rows.find((row) => readString(row.id) === threadId)
    return extractThreadTitleFromObject(thread)
  } catch {
    return null
  }
}

function readThreadRows(value: unknown): JsonObject[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => !!entry)
}

async function updateChatTitleFromCodex(
  chatId: string,
  title: string,
): Promise<void> {
  const chat = await prisma.chat.update({
    where: { id: chatId },
    data: { title },
  })
  emit(chatId, "chat.updated", toChatResponse(chat))
}

export const __testing = {
  approvalMetadata,
  extractThreadName,
  extractAssistantText,
  requestMethodKind,
  serverRequestResult,
  threadModeOverrides,
  turnModeOverrides,
  userInputMetadata,
}
