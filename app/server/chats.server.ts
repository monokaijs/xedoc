import type { CodexAccount, ThreadPreference } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import type {
  ChatAttachmentInput,
  ChatEventPayloads,
  ChatEventType,
  ChatMessageAttachment,
  ChatMessageResponse,
  ChatResponse,
  CodexCollaborationMode,
  CodexJsonRpcResponse,
  CodexPermissionMode,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexReasoningEffort,
  CodexServiceTier,
  ContextWindowUsagePayload,
  CreateChatRequest,
  ExecuteChatRequest,
  JsonObject,
  JsonSerializable,
  RunStatus,
  ServerRequestResponseRequest,
  UpdateChatRequest,
} from "@/types"
import {
  codexRuntimeService,
  jsonRpcIdKey,
  readCodexRateLimitsForAccount,
} from "./codex-runtime.server"
import { normalizeEnvironment } from "./env.server"
import { HttpError } from "./http.server"
import { asJsonObject, readString } from "./json.server"
import { selectRateLimitSnapshot } from "@/lib/rate-limits"
import {
  listLocalCodexSessionSummaries,
  mirrorCodexSessionForAccount,
  readLatestLocalCodexContextUsage,
  readLocalCodexSessionMetadata,
  readLocalCodexSessionTranscript,
  type ImportedLocalMessage,
  type LocalCodexSessionSummary,
} from "./local-codex-import.server"
import { prisma } from "./prisma.server"
import { publishChatEvent } from "./realtime.server"
import {
  archiveThreadPreference,
  getThreadPreference,
  listThreadPreferences,
  preferenceToChatFields,
  upsertThreadPreference,
} from "./thread-preferences.server"
import { readWorkspaceFileMetadata } from "./workspace-files.server"
import { resolveDirectory } from "./workspaces.server"

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
  messageId: string
  requestId: string
  requestKind: "approval" | "permissions" | "userInput"
  rpcId: string | number
  runtime: Pick<CodexRuntimeSession, "rejectServerRequest" | "respondToServerRequest">
  threadId: string
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

type RuntimeThreadState = {
  accountId?: string | null
  interruptRequested: boolean
  messageKeys: Map<string, string>
  messages: ChatMessageResponse[]
  nextSequence: number
  permissionMode: CodexPermissionMode
  primed: boolean
  queuedTurns: QueuedTurn[]
  runId?: string | null
  runtime?: CodexRuntimeSession
  status: RunStatus | "IDLE"
  threadId: string
  turnId?: string | null
  updatedAt: Date
}

type ThreadSnapshot = {
  createdAt: Date
  firstUserMessage?: string | null
  preview?: string | null
  threadId: string
  title?: string | null
  updatedAt: Date
  workingDirectory?: string | null
}

const pendingServerRequests = new Map<string, PendingServerRequest>()
const runtimeStates = new Map<string, RuntimeThreadState>()
const accountRunLocks = new Map<string, Promise<void>>()
const queueFlushLocks = new Map<string, Promise<void>>()
const runProjectionQueues = new Map<string, Promise<void>>()
const timelineMessageLocks = new Map<string, Promise<void>>()
const DEFAULT_CHAT_TITLE = "New Thread"

export async function createChat(dto: CreateChatRequest): Promise<ChatResponse> {
  const account = await readConnectedAccount(dto.accountId)
  const workingDirectory = resolveDirectory(dto.workingDirectory)
  const collaborationMode =
    dto.collaborationMode === undefined
      ? "default"
      : normalizeCollaborationMode(dto.collaborationMode)
  const permissionMode =
    dto.permissionMode === undefined
      ? "default"
      : normalizePermissionMode(dto.permissionMode)
  const runtime = runtimeForAccount(account)
  const threadId = await ensureCodexThread(
    runtime,
    null,
    workingDirectory,
    collaborationMode,
  )
  const preference = await upsertThreadPreference(threadId, {
    accountId: account.id,
    autoRotateAccount: dto.autoRotateAccount ?? false,
    collaborationMode,
    model:
      dto.model === undefined ? undefined : normalizeNullableRuntimeOption(dto.model),
    permissionMode,
    reasoningEffort:
      dto.reasoningEffort === undefined
        ? undefined
        : normalizeReasoningEffort(dto.reasoningEffort),
    serviceTier:
      dto.serviceTier === undefined
        ? undefined
        : normalizeServiceTier(dto.serviceTier),
    title: normalizeChatTitle(dto.title ?? "") ?? null,
    workingDirectory,
  })
  const state = await ensureRuntimeState(threadId)
  state.accountId = account.id
  state.primed = true
  state.runtime = runtime
  state.updatedAt = new Date()
  const chat = await buildChatResponse(threadId, preference)
  emit(threadId, "chat.updated", chat)
  return chat
}

export async function listChats(): Promise<ChatResponse[]> {
  const [preferences, snapshots] = await Promise.all([
    listThreadPreferences(),
    readThreadSnapshots(),
  ])
  const preferencesByThreadId = new Map(
    preferences.map((preference) => [preference.threadId, preference]),
  )
  const threadIds = new Set([
    ...snapshots.keys(),
    ...runtimeStates.keys(),
  ])
  const chats = await Promise.all(
    [...threadIds].map((threadId) =>
      buildChatResponse(
        threadId,
        preferencesByThreadId.get(threadId) ?? null,
        snapshots.get(threadId) ?? null,
      ),
    ),
  )
  return chats
    .filter((chat) => chat.status !== "ARCHIVED")
    .sort(
      (left, right) =>
        new Date(right.lastActivityAt).getTime() -
          new Date(left.lastActivityAt).getTime() ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )
}

export async function getChat(threadId: string): Promise<ChatResponse> {
  const preference = await getThreadPreference(threadId)
  const snapshot = await readThreadSnapshot(threadId)
  if (!snapshot && !runtimeStates.has(threadId)) {
    throw new HttpError(404, "Chat not found.")
  }
  return buildChatResponse(threadId, preference, snapshot)
}

export async function updateChat(
  threadId: string,
  dto: UpdateChatRequest,
): Promise<ChatResponse> {
  const chat = await getChat(threadId)
  if (chat.status === "RUNNING") {
    if (dto.accountId !== undefined && dto.accountId !== chat.accountId) {
      throw new HttpError(400, "Wait for the current run to finish before switching accounts.")
    }
    if (
      dto.collaborationMode !== undefined &&
      normalizeCollaborationMode(dto.collaborationMode) !== chat.collaborationMode
    ) {
      throw new HttpError(400, "Wait for the current run to finish before changing modes.")
    }
    if (dto.workingDirectory !== undefined) {
      throw new HttpError(400, "Wait for the current run to finish before changing workspace.")
    }
  }

  const accountId = await resolveUpdatedChatAccountId(chat.accountId, dto.accountId)
  if (
    runtimeStates.get(threadId)?.primed &&
    accountId !== undefined &&
    accountId !== chat.accountId
  ) {
    throw new HttpError(
      400,
      "Send the first message before switching accounts on this chat.",
    )
  }
  const collaborationMode =
    dto.collaborationMode === undefined
      ? undefined
      : normalizeCollaborationMode(dto.collaborationMode)
  const permissionMode =
    dto.permissionMode === undefined
      ? undefined
      : normalizePermissionMode(dto.permissionMode)
  const title =
    dto.title === undefined
      ? undefined
      : normalizeChatTitle(dto.title) ?? "Untitled chat"
  const workingDirectory =
    dto.workingDirectory === undefined
      ? undefined
      : resolveDirectory(dto.workingDirectory)

  const preference = await upsertThreadPreference(threadId, {
    accountId,
    autoRotateAccount: dto.autoRotateAccount,
    collaborationMode,
    model: dto.model === undefined ? undefined : normalizeNullableRuntimeOption(dto.model),
    permissionMode,
    reasoningEffort:
      dto.reasoningEffort === undefined
        ? undefined
        : normalizeReasoningEffort(dto.reasoningEffort),
    serviceTier:
      dto.serviceTier === undefined ? undefined : normalizeServiceTier(dto.serviceTier),
    title,
    workingDirectory,
  })

  if (accountId) {
    void mirrorCodexSessionForAccount(threadId, accountId).catch((error) => {
      console.warn(
        "Failed to mirror Codex session.",
        error instanceof Error ? error.message : error,
      )
    })
  }
  if (title) {
    void persistThreadTitleToCodex(threadId, preference, title).catch((error) => {
      console.warn(
        "Failed to persist Codex chat title.",
        error instanceof Error ? error.message : error,
      )
    })
  }
  if (permissionMode) {
    const state = runtimeStates.get(threadId)
    if (state) {
      state.permissionMode = permissionMode
    }
    if (permissionMode === "fullAccess") {
      await resolvePendingServerRequestsForFullAccess(threadId)
    }
  }

  const updated = await buildChatResponse(threadId, preference)
  emit(threadId, "chat.updated", updated)
  return updated
}

export async function archiveChat(threadId: string): Promise<ChatResponse> {
  await getChat(threadId)
  const preference = await archiveThreadPreference(threadId)
  const archived = await buildChatResponse(threadId, preference)
  emit(threadId, "chat.updated", archived)
  return archived
}

export async function listMessages(
  threadId: string,
  afterSequence = 0,
  limit = 50,
) {
  const chat = await getChat(threadId)
  const safeLimit = Math.min(Math.max(limit, 1), 200)
  const sourceMessages = await readCodexTranscriptMessages(threadId)
  const sourceResponses = sourceMessages.map((source, index) =>
    sourceTranscriptResponse(threadId, chat, source, index, index + 1),
  )
  const overlay = overlayMessagesForList(threadId, sourceResponses)
  const messages = [...sourceResponses, ...overlay]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((message) => message.sequence > afterSequence)
    .slice(0, safeLimit)
  return {
    data: messages,
    nextCursor: messages.length ? messages[messages.length - 1].sequence : null,
  }
}

export async function readChatContext(threadId: string) {
  await getChat(threadId)
  return { usage: await readLatestLocalCodexContextUsage(threadId) }
}

export async function respondToCodexServerRequest(
  threadId: string,
  requestId: string,
  dto: ServerRequestResponseRequest,
): Promise<ChatMessageResponse> {
  await getChat(threadId)
  const key = serverRequestKey(threadId, requestId)
  const pending = pendingServerRequests.get(key)
  if (!pending) {
    throw new HttpError(410, "Server request is no longer active.")
  }

  const result = serverRequestResult(dto)
  pending.runtime.respondToServerRequest(pending.rpcId, result)
  pendingServerRequests.delete(key)
  const updated = updateRuntimeMessage(threadId, pending.messageId, {
    completedAt: new Date(),
    metadataPatch: {
      decision: dto.decision,
      resolvedAt: new Date().toISOString(),
      result: dto.result ?? result,
      status: "resolved",
    },
    status: "COMPLETED",
  })
  if (!updated) {
    throw new HttpError(410, "Server request is no longer active.")
  }
  emit(threadId, "message.updated", updated)
  return updated
}

export async function executeMessage(
  threadId: string,
  dto: ExecuteChatRequest,
) {
  let chat = await getChat(threadId)
  if (dto.accountId && chat.accountId && dto.accountId !== chat.accountId) {
    throw new HttpError(
      400,
      "Switch the chat account before sending with a different account.",
    )
  }
  if (!dto.accountId && chat.status !== "RUNNING") {
    chat = await autoRotateChatAccountIfNeeded(chat)
  }
  const accountId = dto.accountId ?? chat.accountId
  if (!accountId) {
    throw new HttpError(400, "Choose a Codex account before sending messages.")
  }
  const account = await readConnectedAccount(accountId)
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

  const requestedCollaborationMode =
    dto.collaborationMode === undefined
      ? undefined
      : normalizeCollaborationMode(dto.collaborationMode)
  const collaborationMode = requestedCollaborationMode ?? chat.collaborationMode
  const permissionMode = chat.permissionMode
  const startedAt = new Date()
  const state = await ensureRuntimeState(threadId)

  if (state.status === "RUNNING" || state.status === "QUEUED") {
    if (dto.delivery === "steer") {
      return steerActiveRunMessage({
        account,
        attachments,
        collaborationMode,
        content: dto.content,
        messageContent,
        metadata: dto.metadata ?? {},
        permissionMode,
        startedAt,
        threadId,
        workingDirectory,
      })
    }
    return queueActiveRunMessage({
      accountId,
      attachments,
      automaticTitleSeed: await automaticChatTitleSeed(
        chat,
        automaticTitleContent(dto.content, attachments),
      ),
      collaborationMode,
      content: dto.content,
      messageContent,
      metadata: dto.metadata ?? {},
      permissionMode,
      queuedAt: startedAt,
      threadId,
      workingDirectory,
    })
  }

  const message = appendRuntimeMessage(threadId, {
    completedAt: startedAt,
    content: messageContent,
    metadata: messageMetadataWithAttachments(dto.metadata, attachments),
    role: "USER",
    status: "COMPLETED",
  })
  emit(threadId, "message.created", message)
  const started = await startAssistantRunForMessage({
    account,
    attachments,
    automaticTitleSeed: await automaticChatTitleSeed(
      chat,
      automaticTitleContent(dto.content, attachments),
    ),
    collaborationMode,
    content: dto.content,
    metadata: dto.metadata ?? {},
    permissionMode,
    requestedCollaborationMode,
    startedAt,
    threadId,
    workingDirectory,
  })
  return {
    message,
    assistantMessage: started.assistantMessage,
    runId: started.runId,
    status: "QUEUED" as const,
  }
}

export async function interruptChatRun(threadId: string) {
  const chat = await getChat(threadId)
  if (chat.status !== "RUNNING") {
    throw new HttpError(409, "There is no running task to stop.")
  }
  const state = runtimeStates.get(threadId)
  if (!state?.runId) {
    throw new HttpError(409, "There is no active run to stop.")
  }
  state.interruptRequested = true
  if (state.runtime && state.turnId) {
    await sendTurnInterrupt(state.runtime, state.turnId, threadId)
  }
  return {
    chatId: threadId,
    runId: state.runId,
    status: state.status === "RUNNING" ? "RUNNING" : "QUEUED",
    message: state.turnId
      ? "Stop signal sent to Codex."
      : "Stop requested. Codex will be interrupted as soon as the turn starts.",
  }
}

export async function steerQueuedMessage(
  threadId: string,
  queueId: string,
): Promise<ChatMessageResponse> {
  await getChat(threadId)
  const state = runtimeStates.get(threadId)
  if (!state || (state.status !== "RUNNING" && state.status !== "QUEUED")) {
    throw new HttpError(409, "There is no running task to steer.")
  }
  if (!state.runtime) {
    throw new HttpError(409, "The active turn is not ready for steering yet.")
  }

  const queueIndex = state.queuedTurns.findIndex((turn) => turn.id === queueId)
  if (queueIndex < 0) {
    throw new HttpError(410, "Queued message is no longer pending.")
  }
  const queuedTurn = state.queuedTurns[queueIndex]
  const expectedTurnId =
    state.turnId ?? (await resolveInFlightTurnId(state.runtime, threadId))
  if (!expectedTurnId) {
    throw new HttpError(409, "The active turn has not published a turn id yet.")
  }

  const preference = await getThreadPreference(threadId)
  const collaborationSettings = await resolveCollaborationModeSettings(
    state.runtime,
    preference?.model ?? null,
    (preference?.reasoningEffort as CodexReasoningEffort | null) ?? null,
  )
  const response = await steerCodexTurn(
    state.runtime,
    {
      expectedTurnId,
      threadId,
      ...turnSteerModeOverrides(queuedTurn.collaborationMode, collaborationSettings),
    },
    queuedTurn.content,
    queuedTurn.attachments,
  )

  state.turnId = getTurnId(response) ?? expectedTurnId
  state.queuedTurns.splice(queueIndex, 1)
  const steeredAt = new Date()
  const updated = updateRuntimeMessage(threadId, queuedTurn.messageId, {
    completedAt: steeredAt,
    metadataPatch: {
      delivery: "steer",
      queueStatus: "steered",
      runId: state.runId ?? null,
      steeredAt: steeredAt.toISOString(),
    },
    turnId: state.turnId,
  })
  if (!updated) {
    throw new HttpError(410, "Queued message is no longer available.")
  }

  emit(threadId, "chat.updated", await getChat(threadId))
  emit(threadId, "message.updated", updated)
  return updated
}

export function readInMemoryThreadStatus(threadId: string): ChatResponse["status"] {
  const status = runtimeStates.get(threadId)?.status
  return status === "RUNNING" || status === "QUEUED" ? "RUNNING" : "IDLE"
}

async function readConnectedAccount(accountId: string): Promise<CodexAccount> {
  const account = await prisma.codexAccount.findUnique({ where: { id: accountId } })
  if (!account) {
    throw new HttpError(400, "Account not found.")
  }
  if (account.status !== "CONNECTED") {
    throw new HttpError(400, "Authenticate the account before using this chat.")
  }
  return account
}

async function resolveUpdatedChatAccountId(
  currentAccountId: string | null | undefined,
  accountId: string | null | undefined,
): Promise<string | null | undefined> {
  if (accountId === undefined || accountId === currentAccountId) {
    return undefined
  }
  if (accountId === null) {
    return null
  }
  return (await readConnectedAccount(accountId)).id
}

async function readThreadSnapshots(): Promise<Map<string, ThreadSnapshot>> {
  const sessions = await listLocalCodexSessionSummaries()
  const snapshots = new Map<string, ThreadSnapshot>()
  for (const session of sessions) {
    snapshots.set(session.externalThreadId, snapshotFromSession(session))
  }
  return snapshots
}

async function readThreadSnapshot(
  threadId: string,
): Promise<ThreadSnapshot | null> {
  const session = await readLocalCodexSessionMetadata(threadId)
  if (!session) {
    return null
  }
  return {
    createdAt: session.createdAt,
    firstUserMessage: session.firstUserMessage ?? null,
    preview: session.preview ?? null,
    threadId,
    title: session.title,
    updatedAt: session.updatedAt,
    workingDirectory: session.workingDirectory ?? null,
  }
}

function snapshotFromSession(session: LocalCodexSessionSummary): ThreadSnapshot {
  return {
    createdAt: session.createdAt,
    firstUserMessage: session.firstUserMessage ?? null,
    preview: session.preview ?? null,
    threadId: session.externalThreadId,
    title: session.title,
    updatedAt: session.updatedAt,
    workingDirectory: session.workingDirectory ?? null,
  }
}

async function buildChatResponse(
  threadId: string,
  preference: ThreadPreference | null,
  snapshot?: ThreadSnapshot | null,
): Promise<ChatResponse> {
  const resolvedSnapshot = snapshot === undefined ? await readThreadSnapshot(threadId) : snapshot
  const state = runtimeStates.get(threadId)
  const preferenceFields = preferenceToChatFields(preference)
  const createdAt =
    preference?.createdAt ??
    resolvedSnapshot?.createdAt ??
    state?.updatedAt ??
    new Date()
  const updatedAt =
    state?.updatedAt ??
    resolvedSnapshot?.updatedAt ??
    preference?.updatedAt ??
    createdAt
  const title = resolveChatDisplayTitle({
    preferenceTitle: preference?.title,
    preview: resolvedSnapshot?.preview,
    seed:
      lastUserMessageContent(state?.messages ?? []) ??
      resolvedSnapshot?.firstUserMessage ??
      null,
    snapshotTitle: resolvedSnapshot?.title,
  })
  return {
    ...preferenceFields,
    id: threadId,
    externalThreadId: threadId,
    lastActivityAt: updatedAt,
    status: preference?.archivedAt
      ? "ARCHIVED"
      : state?.status === "RUNNING" || state?.status === "QUEUED"
        ? "RUNNING"
        : "IDLE",
    title,
    workingDirectory:
      resolvedSnapshot?.workingDirectory ?? preferenceFields.workingDirectory,
    createdAt,
    updatedAt,
  }
}

async function readCodexTranscriptMessages(
  threadId: string,
): Promise<SourceTranscriptMessage[]> {
  const session = await readLocalCodexSessionTranscript(threadId)
  return session
    ? session.messages.map((message) => sourceMessageFromLocalSession(message))
    : []
}

function sourceTranscriptResponse(
  threadId: string,
  chat: ChatResponse,
  source: SourceTranscriptMessage,
  index: number,
  sequence: number,
): ChatMessageResponse {
  const createdAt = source.createdAt ?? chat.createdAt
  const completedAt = source.completedAt ?? source.createdAt ?? createdAt
  return {
    chatId: threadId,
    completedAt,
    content: source.content,
    createdAt,
    id: sourceTranscriptId(threadId, source, index),
    itemId: source.itemId ?? null,
    kind: source.kind ?? "CHAT",
    metadata: source.metadata
      ? (toSerializable(source.metadata) as ChatMessageResponse["metadata"])
      : sourceTranscriptMetadata(source),
    rawPayload: toSerializable(source.rawPayload ?? null),
    requestId: null,
    role: source.role,
    runId: null,
    sequence,
    status: "COMPLETED",
    turnId: source.turnId ?? null,
  }
}

function sourceTranscriptId(
  threadId: string,
  source: SourceTranscriptMessage,
  index: number,
): string {
  return [
    "codex",
    threadId,
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
    itemId: message.itemId,
    kind: message.kind,
    metadata: message.metadata,
    rawPayload: message.rawPayload,
    role: message.role,
    source: "session",
    turnId: message.turnId,
  }
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

async function ensureRuntimeState(threadId: string): Promise<RuntimeThreadState> {
  const existing = runtimeStates.get(threadId)
  if (existing) {
    return existing
  }
  const sourceCount = (await readLocalCodexSessionTranscript(threadId))?.messages.length ?? 0
  const state: RuntimeThreadState = {
    interruptRequested: false,
    messageKeys: new Map(),
    messages: [],
    nextSequence: sourceCount + 1,
    permissionMode: "default",
    primed: false,
    queuedTurns: [],
    status: "IDLE",
    threadId,
    updatedAt: new Date(),
  }
  runtimeStates.set(threadId, state)
  return state
}

function getRuntimeState(threadId: string): RuntimeThreadState {
  const state = runtimeStates.get(threadId)
  if (!state) {
    throw new Error(`Missing runtime state for ${threadId}.`)
  }
  return state
}

function appendRuntimeMessage(
  threadId: string,
  input: {
    completedAt?: Date | null
    content: string
    id?: string
    itemId?: string | null
    kind?: ChatMessageResponse["kind"]
    metadata?: unknown
    rawPayload?: unknown
    requestId?: string | null
    role: ChatMessageResponse["role"]
    runId?: string | null
    status?: ChatMessageResponse["status"]
    turnId?: string | null
  },
): ChatMessageResponse {
  const state = getRuntimeState(threadId)
  const createdAt = new Date()
  const message: ChatMessageResponse = {
    chatId: threadId,
    completedAt: input.completedAt ?? null,
    content: input.content,
    createdAt,
    id: input.id ?? `runtime:${threadId}:${randomUUID()}`,
    itemId: input.itemId ?? null,
    kind: input.kind ?? "CHAT",
    metadata: input.metadata
      ? (toSerializable(input.metadata) as ChatMessageResponse["metadata"])
      : null,
    rawPayload: input.rawPayload ? toSerializable(input.rawPayload) : null,
    requestId: input.requestId ?? null,
    role: input.role,
    runId: input.runId ?? state.runId ?? null,
    sequence: state.nextSequence,
    status: input.status ?? "PENDING",
    turnId: input.turnId ?? null,
  }
  state.nextSequence += 1
  state.updatedAt = createdAt
  state.messages.push(message)
  return message
}

function updateRuntimeMessage(
  threadId: string,
  messageId: string,
  patch: {
    completedAt?: Date | null
    content?: string
    metadata?: unknown
    metadataPatch?: JsonObject
    rawPayload?: unknown
    status?: ChatMessageResponse["status"]
    turnId?: string | null
  },
): ChatMessageResponse | null {
  const state = runtimeStates.get(threadId)
  const index = state?.messages.findIndex((message) => message.id === messageId) ?? -1
  if (!state || index < 0) {
    return null
  }
  const existing = state.messages[index]
  const updated: ChatMessageResponse = {
    ...existing,
    completedAt: patch.completedAt ?? existing.completedAt,
    content: patch.content ?? existing.content,
    metadata:
      patch.metadata !== undefined
        ? (toSerializable(patch.metadata) as ChatMessageResponse["metadata"])
        : patch.metadataPatch
          ? ({
              ...(asJsonObject(existing.metadata) ?? {}),
              ...patch.metadataPatch,
            } as ChatMessageResponse["metadata"])
          : existing.metadata,
    rawPayload:
      patch.rawPayload !== undefined
        ? toSerializable(patch.rawPayload)
        : existing.rawPayload,
    status: patch.status ?? existing.status,
    turnId: patch.turnId === undefined ? existing.turnId : patch.turnId,
  }
  state.messages[index] = updated
  state.updatedAt = new Date()
  return updated
}

function overlayMessagesForList(
  threadId: string,
  sourceMessages: ChatMessageResponse[],
): ChatMessageResponse[] {
  const state = runtimeStates.get(threadId)
  if (!state) {
    return []
  }
  if (!sourceMessages.length) {
    return state.messages
  }
  return state.messages.filter((message) => keepOverlayMessage(message, sourceMessages))
}

function keepOverlayMessage(
  message: ChatMessageResponse,
  sourceMessages: ChatMessageResponse[],
): boolean {
  if (
    message.status === "PENDING" ||
    message.status === "STREAMING" ||
    message.kind === "APPROVAL" ||
    message.kind === "USER_INPUT_PROMPT"
  ) {
    return true
  }
  return !sourceMessages.some((source) =>
    messagesRepresentSameTranscriptEntry(source, message),
  )
}

function messagesRepresentSameTranscriptEntry(
  source: ChatMessageResponse,
  overlay: ChatMessageResponse,
): boolean {
  if (source.kind !== overlay.kind || source.role !== overlay.role) {
    return false
  }
  if (source.turnId && overlay.turnId && source.turnId === overlay.turnId) {
    return true
  }
  if (source.itemId && overlay.itemId && source.itemId === overlay.itemId) {
    return true
  }
  return (
    source.kind === "CHAT" &&
    normalizedComparableContent(source.content) ===
      normalizedComparableContent(overlay.content)
  )
}

function normalizedComparableContent(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

async function startAssistantRunForMessage({
  account,
  attachments,
  automaticTitleSeed,
  collaborationMode,
  content,
  metadata,
  permissionMode,
  requestedCollaborationMode,
  startedAt,
  threadId,
  workingDirectory,
}: {
  account: CodexAccount
  attachments: PreparedAttachment[]
  automaticTitleSeed: string | null
  collaborationMode: CodexCollaborationMode
  content: string
  metadata: Record<string, unknown>
  permissionMode: CodexPermissionMode
  requestedCollaborationMode?: CodexCollaborationMode | null
  startedAt: Date
  threadId: string
  workingDirectory: string
}) {
  const state = await ensureRuntimeState(threadId)
  const runId = `run:${threadId}:${randomUUID()}`
  state.accountId = account.id
  state.interruptRequested = false
  state.permissionMode = permissionMode
  state.runId = runId
  state.status = "QUEUED"
  state.turnId = null
  state.updatedAt = startedAt
  if (requestedCollaborationMode) {
    await upsertThreadPreference(threadId, { collaborationMode: requestedCollaborationMode })
  }
  const assistantMessage = appendRuntimeMessage(threadId, {
    content: "",
    kind: "CHAT",
    role: "ASSISTANT",
    runId,
    status: "PENDING",
  })
  emit(threadId, "chat.updated", await getChat(threadId))
  emit(threadId, "message.created", assistantMessage)
  emit(threadId, "run.status", { runId, status: "QUEUED" })
  void runCodex(
    threadId,
    runId,
    assistantMessage.id,
    account,
    content,
    metadata,
    attachments,
    workingDirectory,
    collaborationMode,
    automaticTitleSeed,
  )
  return { assistantMessage, runId }
}

async function queueActiveRunMessage({
  accountId,
  attachments,
  automaticTitleSeed,
  collaborationMode,
  content,
  messageContent,
  metadata,
  permissionMode,
  queuedAt,
  threadId,
  workingDirectory,
}: {
  accountId: string
  attachments: PreparedAttachment[]
  automaticTitleSeed: string | null
  collaborationMode: CodexCollaborationMode
  content: string
  messageContent: string
  metadata: Record<string, unknown>
  permissionMode: CodexPermissionMode
  queuedAt: Date
  threadId: string
  workingDirectory: string
}) {
  const queueId = randomUUID()
  const message = appendRuntimeMessage(threadId, {
    completedAt: queuedAt,
    content: messageContent,
    metadata: messageMetadataWithAttachments(
      {
        ...metadata,
        delivery: "queue",
        queuedAt: queuedAt.toISOString(),
        queueId,
        queueStatus: "queued",
      },
      attachments,
    ),
    role: "USER",
    status: "COMPLETED",
  })
  const state = getRuntimeState(threadId)
  state.queuedTurns.push({
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
  emit(threadId, "chat.updated", await getChat(threadId))
  emit(threadId, "message.created", message)
  return {
    message,
    assistantMessage: null,
    runId: null,
    status: "QUEUED" as const,
    delivery: "queue" as const,
    queued: true,
  }
}

async function steerActiveRunMessage({
  account,
  attachments,
  collaborationMode,
  content,
  messageContent,
  metadata,
  startedAt,
  threadId,
}: {
  account: CodexAccount
  attachments: PreparedAttachment[]
  collaborationMode: CodexCollaborationMode
  content: string
  messageContent: string
  metadata: Record<string, unknown>
  permissionMode: CodexPermissionMode
  startedAt: Date
  threadId: string
  workingDirectory: string
}) {
  void account
  const state = runtimeStates.get(threadId)
  if (!state?.runtime) {
    throw new HttpError(409, "The active turn is not ready for steering yet.")
  }
  const expectedTurnId =
    state.turnId ?? (await resolveInFlightTurnId(state.runtime, threadId))
  if (!expectedTurnId) {
    throw new HttpError(409, "The active turn has not published a turn id yet.")
  }
  const preference = await getThreadPreference(threadId)
  const collaborationSettings = await resolveCollaborationModeSettings(
    state.runtime,
    preference?.model ?? null,
    (preference?.reasoningEffort as CodexReasoningEffort | null) ?? null,
  )
  const response = await steerCodexTurn(
    state.runtime,
    {
      expectedTurnId,
      threadId,
      ...turnSteerModeOverrides(collaborationMode, collaborationSettings),
    },
    content,
    attachments,
  )
  state.turnId = getTurnId(response) ?? expectedTurnId
  const message = appendRuntimeMessage(threadId, {
    completedAt: startedAt,
    content: messageContent,
    metadata: messageMetadataWithAttachments(
      {
        ...metadata,
        delivery: "steer",
        steeredAt: startedAt.toISOString(),
      },
      attachments,
    ),
    role: "USER",
    status: "COMPLETED",
  })
  emit(threadId, "chat.updated", await getChat(threadId))
  emit(threadId, "message.created", message)
  return {
    message,
    assistantMessage: null,
    runId: state.runId,
    status: "RUNNING" as const,
    delivery: "steer" as const,
    steered: true,
  }
}

async function runCodex(
  threadId: string,
  runId: string,
  assistantMessageId: string,
  account: CodexAccount,
  content: string,
  metadata: Record<string, unknown>,
  attachments: PreparedAttachment[],
  workingDirectory: string,
  collaborationMode: CodexCollaborationMode,
  automaticTitleSeed: string | null,
): Promise<void> {
  return withAccountRunLock(account.id, () =>
    runCodexWithAccountLock(
      threadId,
      runId,
      assistantMessageId,
      account,
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
  threadId: string,
  runId: string,
  assistantMessageId: string,
  account: CodexAccount,
  content: string,
  metadata: Record<string, unknown>,
  attachments: PreparedAttachment[],
  workingDirectory: string,
  collaborationMode: CodexCollaborationMode,
  automaticTitleSeed: string | null,
): Promise<void> {
  const state = getRuntimeState(threadId)
  const preference = await getThreadPreference(threadId)
  const permissionMode = normalizeStoredPermissionMode(preference?.permissionMode)
  const runtime = runtimeForAccount(account)
  const usePrimedThread =
    state.primed && state.accountId === account.id && state.runtime === runtime
  state.permissionMode = permissionMode
  state.runtime = runtime
  state.status = "RUNNING"
  state.updatedAt = new Date()
  const streaming = updateRuntimeMessage(threadId, assistantMessageId, {
    status: "STREAMING",
  })
  if (streaming) {
    emit(threadId, "message.updated", streaming)
  }
  emit(threadId, "chat.updated", await getChat(threadId))
  emit(threadId, "run.status", { runId, status: "RUNNING" })
  await mirrorCodexSessionForAccount(threadId, account.id)

  let streamedContent = ""
  const streamBuffers = new Map<string, string>()
  let turnId: string | undefined
  let turnStarted = false
  let terminalWaitAbort: AbortController | null = null
  let terminalEventPromise: Promise<CodexJsonRpcResponse> | null = null
  const unsubscribeEvents = state.runtime.onEvent((event) => {
    if (!eventBelongsToTurn(event, threadId, turnId)) {
      return
    }
    void enqueueRunProjection(runId, () =>
      projectCodexEvent(
        {
          assistantMessageId,
          onAssistantContent: (value) => {
            streamedContent = value
          },
          runId,
          streamBuffers,
          threadId,
        },
        event,
      ),
    ).catch((error) => logProjectionError("Codex event projection failed.", error))
  })
  const unsubscribeRequests = state.runtime.onServerRequest((request) => {
    if (!serverRequestBelongsToTurn(request, threadId, turnId)) {
      return
    }
    void enqueueRunProjection(runId, () =>
      projectCodexServerRequest(
        {
          permissionMode: () => state.permissionMode,
          runId,
          runtime: state.runtime!,
          threadId,
        },
        request,
      ),
    ).catch((error) =>
      logProjectionError("Codex server request projection failed.", error),
    )
  })

  try {
    if (!usePrimedThread) {
      const resumedThreadId = await ensureCodexThread(
        state.runtime,
        threadId,
        workingDirectory,
        collaborationMode,
      )
      if (resumedThreadId !== threadId) {
        throw new Error("Codex returned a different thread id while resuming.")
      }
    }
    scheduleAutomaticChatTitleIfNeeded({
      cwd: workingDirectory,
      runtime: state.runtime,
      seed: automaticTitleSeed,
      threadId,
    })
    const collaborationSettings = await resolveCollaborationModeSettings(
      state.runtime,
      preference?.model ?? null,
      (preference?.reasoningEffort as CodexReasoningEffort | null) ?? null,
    )
    terminalWaitAbort = new AbortController()
    terminalEventPromise = state.runtime.waitForEvent(
      (event) =>
        turnEventIsTerminal(event) &&
        readEventThreadId(event) === threadId &&
        (!turnId || eventTurnId(event) === turnId),
      600_000,
      terminalWaitAbort.signal,
    )
    const turnResponse = await startCodexTurn(
      state.runtime,
      {
        threadId,
        cwd: workingDirectory,
        ...(preference?.model ? { model: preference.model } : {}),
        ...(preference?.reasoningEffort ? { effort: preference.reasoningEffort } : {}),
        ...(preference?.serviceTier ? { serviceTier: preference.serviceTier } : {}),
        ...turnModeOverrides(
          collaborationMode,
          collaborationSettings,
          permissionMode,
        ),
        metadata,
      },
      content,
      attachments,
    )
    turnStarted = true
    turnId = getTurnId(turnResponse)
    state.primed = false
    state.turnId = turnId ?? null
    if (turnId && state.interruptRequested) {
      await sendTurnInterrupt(state.runtime, turnId, threadId)
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
      state.runtime,
      threadId,
      turnId,
    )
    const finalContent =
      historyContent ||
      extractAssistantText(completedEvent) ||
      extractAssistantText(turnResponse) ||
      streamedContent
    const finishedAt = new Date()
    const completed = updateRuntimeMessage(threadId, assistantMessageId, {
      completedAt: finishedAt,
      content: finalContent,
      rawPayload: completedEvent,
      status: "COMPLETED",
      turnId: turnId ?? null,
    })
    settleOpenRunTimelineMessages(threadId, runId, "COMPLETED")
    expirePendingServerRequests(threadId, runId, "Codex completed the turn.")
    state.status = "IDLE"
    state.runtime = undefined
    state.updatedAt = finishedAt
    const resetCollaborationMode =
      collaborationMode === "plan" && runHasPlanResult(threadId, runId)
    if (resetCollaborationMode) {
      await upsertThreadPreference(threadId, { collaborationMode: "default" })
    }
    emit(threadId, "chat.updated", await getChat(threadId))
    if (completed) {
      emit(threadId, "message.completed", completed)
    }
    emit(threadId, "run.status", { runId, status: "COMPLETED" })
    await refreshThreadTitleFromCodex(runtimeForAccount(account), threadId)
    await mirrorCodexSessionForAccount(threadId, account.id)
  } catch (error) {
    terminalWaitAbort?.abort()
    await terminalEventPromise?.catch(() => undefined)
    const message = error instanceof Error ? error.message : "Codex run failed."
    const keepPrimedRuntime = usePrimedThread && !turnStarted
    expirePendingServerRequests(threadId, runId, message)
    const failedAt = new Date()
    if (error instanceof CodexRunInterruptedError) {
      settleOpenRunTimelineMessages(threadId, runId, "COMPLETED")
      const stopped = updateRuntimeMessage(threadId, assistantMessageId, {
        completedAt: failedAt,
        content: streamedContent,
        metadataPatch: { interrupted: true, kind: "assistant" },
        status: "COMPLETED",
      })
      state.status = "IDLE"
      state.runtime = keepPrimedRuntime ? runtime : undefined
      state.updatedAt = failedAt
      emit(threadId, "chat.updated", await getChat(threadId))
      if (stopped) {
        emit(threadId, "message.completed", stopped)
      }
      emit(threadId, "run.status", {
        error: message,
        runId,
        status: "CANCELLED",
      })
      return
    }
    settleOpenRunTimelineMessages(threadId, runId, "FAILED")
    const failed = updateRuntimeMessage(threadId, assistantMessageId, {
      completedAt: failedAt,
      content: streamedContent,
      status: "FAILED",
    })
    state.status = "IDLE"
    state.runtime = keepPrimedRuntime ? runtime : undefined
    state.updatedAt = failedAt
    emit(threadId, "chat.updated", await getChat(threadId))
    if (failed) {
      emit(threadId, "message.failed", { ...failed, error: message })
    }
    emit(threadId, "run.status", {
      error: message,
      runId,
      status: "FAILED",
    })
  } finally {
    terminalWaitAbort?.abort()
    unsubscribeEvents()
    unsubscribeRequests()
    runProjectionQueues.delete(runId)
    state.runId = null
    state.turnId = null
    if (state.queuedTurns.length) {
      scheduleQueuedTurnFlush(threadId)
    } else {
      scheduleIdleAutoRotate(threadId)
    }
  }
}

class CodexRunInterruptedError extends Error {}

async function flushNextQueuedTurn(threadId: string): Promise<void> {
  const state = runtimeStates.get(threadId)
  if (!state || state.status === "RUNNING" || state.status === "QUEUED") {
    return
  }
  const queuedTurn = state.queuedTurns.shift()
  if (!queuedTurn) {
    return
  }
  try {
    const chat = await autoRotateChatAccountIfNeeded(await getChat(threadId))
    const account = await readConnectedAccount(chat.accountId ?? queuedTurn.accountId)
    const startedAt = new Date()
    const started = await startAssistantRunForMessage({
      account,
      attachments: queuedTurn.attachments,
      automaticTitleSeed: queuedTurn.automaticTitleSeed,
      collaborationMode: queuedTurn.collaborationMode,
      content: queuedTurn.content,
      metadata: queuedTurn.metadata,
      permissionMode: queuedTurn.permissionMode,
      startedAt,
      threadId,
      workingDirectory: queuedTurn.workingDirectory,
    })
    const updated = updateRuntimeMessage(threadId, queuedTurn.messageId, {
      metadataPatch: {
        dequeuedAt: startedAt.toISOString(),
        queueStatus: "running",
        runId: started.runId,
      },
    })
    if (updated) {
      emit(threadId, "message.updated", updated)
    }
  } catch (error) {
    const updated = updateRuntimeMessage(threadId, queuedTurn.messageId, {
      metadataPatch: {
        error: error instanceof Error ? error.message : "Queued message failed.",
        failedAt: new Date().toISOString(),
        queueStatus: "failed",
      },
    })
    if (updated) {
      emit(threadId, "message.updated", updated)
    }
  }
}

function scheduleQueuedTurnFlush(threadId: string): void {
  const previous = queueFlushLocks.get(threadId) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(() => flushNextQueuedTurn(threadId))
  const stored = current.catch(() => undefined)
  queueFlushLocks.set(threadId, stored)
  void stored.finally(() => {
    if (queueFlushLocks.get(threadId) === stored) {
      queueFlushLocks.delete(threadId)
    }
  })
}

function scheduleIdleAutoRotate(threadId: string): void {
  void autoRotateChatAccountIfNeeded(getChatSnapshotOrNull(threadId)).catch(
    (error) => {
      console.warn(
        "Failed to auto rotate idle chat account.",
        error instanceof Error ? error.message : error,
      )
    },
  )
}

async function getChatSnapshotOrNull(
  threadId: string,
): Promise<ChatResponse | null> {
  try {
    return await getChat(threadId)
  } catch {
    return null
  }
}

async function autoRotateChatAccountIfNeeded(
  chatOrPromise: ChatResponse | Promise<ChatResponse | null> | null,
): Promise<ChatResponse> {
  const chat = await chatOrPromise
  if (!chat) {
    throw new HttpError(404, "Chat not found.")
  }
  if (
    !chat.autoRotateAccount ||
    chat.status === "RUNNING" ||
    runtimeStates.get(chat.id)?.primed
  ) {
    return chat
  }
  const connectedAccounts = await prisma.codexAccount.findMany({
    orderBy: { createdAt: "asc" },
    where: { status: "CONNECTED" },
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
  const preference = await upsertThreadPreference(chat.id, {
    accountId: bestAccount.id,
  })
  void mirrorCodexSessionForAccount(chat.id, bestAccount.id).catch(() => undefined)
  const updated = await buildChatResponse(chat.id, preference)
  emit(chat.id, "chat.updated", updated)
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
  return remainingPercents.length ? Math.min(...remainingPercents) : 0
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

function prepareImageAttachment(
  input: Extract<ChatAttachmentInput, { kind: "image" }>,
): PreparedAttachment {
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
  const name = normalizeAttachmentName(
    input.name,
    mimeType.split("/").at(-1) ?? "image",
  )
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
    .filter(
      (
        attachment,
      ): attachment is Extract<ChatMessageAttachment, { kind: "image" }> =>
        attachment.kind === "image",
    )
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

function automaticChatTitleSeed(
  chat: ChatResponse,
  currentContent: string,
): string | null {
  if (!isGenericChatTitle(chat.title)) {
    return null
  }
  const trimmed = currentContent.trim()
  return trimmed ? trimmed : null
}

function withAccountRunLock<T>(
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
  return previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      release()
      if (accountRunLocks.get(accountId) === next) {
        accountRunLocks.delete(accountId)
      }
    })
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
      readJsonObjectArray(result?.data) ??
        readJsonObjectArray(result?.items) ??
        readJsonObjectArray(result?.turns) ??
        [],
      true,
    )
  } catch {
    // Older runtimes only expose turns through thread/read.
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
  return turnStateSnapshot(readJsonObjectArray(thread?.turns) ?? [], false)
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
  return status?.replace(/[_-]/g, "").trim().toLowerCase() ?? null
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
  const fallbackText = [
    content.trim(),
    ...attachments.flatMap((attachment) => attachment.fallbackText ?? []),
  ]
    .filter(Boolean)
    .join("\n\n")
  const images = attachments.filter(
    (attachment) => attachment.message.kind === "image",
  )
  const mentions = attachments.filter(
    (attachment) => attachment.message.kind === "file",
  )
  const textItem = {
    text: fallbackText,
    text_elements: [],
    type: "text",
  }
  const build = (imageKey: "image_url" | "url", includeMentions: boolean) => [
    textItem,
    ...images.map((attachment) => ({
      [imageKey]: (
        attachment.message as Extract<ChatMessageAttachment, { kind: "image" }>
      ).url,
      type: "image",
    })),
    ...(includeMentions
      ? mentions.map((attachment) => attachment.runtime)
      : []),
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
  runtime: Pick<CodexRuntimeSession, "request">,
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
    // Fall back to model/list below.
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
    // Native mode still works without resolved settings.
  }
  return null
}

type ProjectCodexEventContext = {
  assistantMessageId: string
  onAssistantContent: (content: string) => void
  runId: string
  streamBuffers: Map<string, string>
  threadId: string
}

type ProjectCodexRequestContext = {
  permissionMode: () => CodexPermissionMode
  runId: string
  runtime: CodexRuntimeSession
  threadId: string
}

async function projectCodexEvent(
  context: ProjectCodexEventContext,
  event: CodexJsonRpcResponse,
): Promise<void> {
  const contextUsage = extractContextWindowUsage(event)
  if (contextUsage) {
    emit(context.threadId, "context.updated", contextUsage)
  }
  if (isContextWindowUsageEvent(event)) {
    return
  }
  if (isCompactionEvent(event)) {
    await upsertTimelineMessage({
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
      threadId: context.threadId,
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
      await updateThreadTitleFromCodex(context.threadId, title)
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
      content: nextContent,
      fallbackMessageId: context.assistantMessageId,
      itemId,
      kind: "CHAT",
      metadata: { kind: "assistant", phase: readString(params?.phase) },
      rawPayload: event,
      role: "ASSISTANT",
      runId: context.runId,
      status: "STREAMING",
      threadId: context.threadId,
      turnId: eventTurnId(event),
    })
    emit(context.threadId, "message.delta", {
      content: nextContent,
      delta,
      messageId: response.id,
      runId: context.runId,
    })
    return
  }
  if (method === "item/started" && isAssistantItem(itemType)) {
    await upsertTimelineMessage({
      content: "",
      fallbackMessageId: context.assistantMessageId,
      itemId: eventItemId(event),
      kind: "CHAT",
      metadata: { kind: "assistant", phase: readString(item?.phase) },
      rawPayload: event,
      role: "ASSISTANT",
      runId: context.runId,
      status: "STREAMING",
      threadId: context.threadId,
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
      threadId: context.threadId,
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
    markServerRequestResolved(context.threadId, event)
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
  const metadata =
    requestKind === "userInput"
      ? userInputMetadata(method, requestId, params, request)
      : approvalMetadata(method, requestId, params, requestKind, request)
  if (context.permissionMode() === "fullAccess" && requestKind !== "userInput") {
    const result = fullAccessServerRequestResult(requestKind)
    context.runtime.respondToServerRequest(request.id, result)
    await upsertTimelineMessage({
      completedAt: new Date(),
      content: serverRequestContent(metadata),
      itemId: readString(params.itemId),
      kind: "APPROVAL",
      metadata: {
        ...metadata,
        autoApproved: true,
        decision: requestKind === "approval" ? "acceptForSession" : undefined,
        resolvedAt: new Date().toISOString(),
        result,
        status: "resolved",
      },
      rawPayload: request,
      requestId,
      role: "SYSTEM",
      runId: context.runId,
      status: "COMPLETED",
      threadId: context.threadId,
      turnId: readString(params.turnId),
    })
    return
  }
  const message = await upsertTimelineMessage({
    content: serverRequestContent(metadata),
    itemId: readString(params.itemId),
    kind: requestKind === "userInput" ? "USER_INPUT_PROMPT" : "APPROVAL",
    metadata,
    rawPayload: request,
    requestId,
    role: "SYSTEM",
    runId: context.runId,
    status: "PENDING",
    threadId: context.threadId,
    turnId: readString(params.turnId),
  })
  pendingServerRequests.set(serverRequestKey(context.threadId, requestId), {
    messageId: message.id,
    requestId,
    requestKind,
    rpcId: request.id,
    runtime: context.runtime,
    threadId: context.threadId,
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
  const itemId =
    eventItemId(event) ?? `${kind.toLowerCase()}:${eventTurnId(event) ?? "turn"}`
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
    content: nextContent,
    itemId,
    kind,
    metadata: options.metadata,
    rawPayload: event,
    role: "SYSTEM",
    runId: context.runId,
    status: eventIsCompleted(event) ? "COMPLETED" : "STREAMING",
    threadId: context.threadId,
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
    threadId: context.threadId,
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
    status:
      status === "failed"
        ? "FAILED"
        : eventIsCompleted(event)
          ? "COMPLETED"
          : "STREAMING",
    threadId: context.threadId,
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
    threadId: context.threadId,
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
    threadId: context.threadId,
    turnId: eventTurnId(event),
  })
}

async function upsertTimelineMessage(input: {
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
  threadId: string
  turnId?: string | null
}): Promise<ChatMessageResponse> {
  return withTimelineMessageLock(timelineMessageLockKey(input), async () => {
    const state = getRuntimeState(input.threadId)
    const existing = findTimelineMessage(state, input)
    const message = existing
      ? updateRuntimeMessage(input.threadId, existing.id, {
          completedAt: input.completedAt,
          content: input.content,
          metadata: input.metadata,
          rawPayload: input.rawPayload,
          status: input.status,
          turnId: input.turnId ?? existing.turnId,
        })!
      : appendRuntimeMessage(input.threadId, {
          completedAt: input.completedAt,
          content: input.content,
          itemId: input.itemId,
          kind: input.kind,
          metadata: input.metadata,
          rawPayload: input.rawPayload,
          requestId: input.requestId,
          role: input.role,
          runId: input.runId,
          status: input.status,
          turnId: input.turnId,
        })
    const key = timelineMessageLockKey(input)
    if (key) {
      state.messageKeys.set(key, message.id)
    }
    emit(input.threadId, existing ? "message.updated" : "message.created", message)
    return message
  })
}

function timelineMessageLockKey(input: {
  fallbackMessageId?: string
  itemId?: string | null
  kind: ChatMessageResponse["kind"]
  requestId?: string | null
  threadId: string
}): string | null {
  if (input.requestId) {
    return `${input.threadId}:request:${input.requestId}`
  }
  if (input.itemId) {
    return `${input.threadId}:item:${input.kind}:${input.itemId}`
  }
  if (input.fallbackMessageId) {
    return `${input.threadId}:fallback:${input.fallbackMessageId}`
  }
  return null
}

function findTimelineMessage(
  state: RuntimeThreadState,
  input: {
    fallbackMessageId?: string
    itemId?: string | null
    kind: ChatMessageResponse["kind"]
    requestId?: string | null
    threadId: string
  },
): ChatMessageResponse | null {
  const key = timelineMessageLockKey(input)
  const keyed = key ? state.messageKeys.get(key) : null
  if (keyed) {
    return state.messages.find((message) => message.id === keyed) ?? null
  }
  if (input.requestId) {
    return (
      state.messages.find((message) => message.requestId === input.requestId) ??
      null
    )
  }
  if (input.itemId) {
    return (
      state.messages.find(
        (message) =>
          message.itemId === input.itemId && message.kind === input.kind,
      ) ?? null
    )
  }
  if (input.fallbackMessageId) {
    return (
      state.messages.find((message) => message.id === input.fallbackMessageId) ??
      null
    )
  }
  return null
}

function markServerRequestResolved(
  threadId: string,
  event: CodexJsonRpcResponse,
): void {
  const params = asJsonObject(event.params) ?? {}
  const requestId = readString(params.requestId) ?? readString(params.id)
  if (!requestId) {
    return
  }
  pendingServerRequests.delete(serverRequestKey(threadId, requestId))
  const state = runtimeStates.get(threadId)
  const message = state?.messages.find((entry) => entry.requestId === requestId)
  if (!message) {
    return
  }
  const updated = updateRuntimeMessage(threadId, message.id, {
    completedAt: new Date(),
    metadataPatch: {
      resolvedAt: new Date().toISOString(),
      result: params.result === undefined ? null : toSerializable(params.result),
      status: "resolved",
    },
    status: "COMPLETED",
  })
  if (updated) {
    emit(threadId, "message.updated", updated)
  }
}

function expirePendingServerRequests(
  threadId: string,
  runId: string,
  reason: string,
): void {
  const state = runtimeStates.get(threadId)
  if (!state) {
    return
  }
  for (const message of state.messages) {
    if (
      message.runId !== runId ||
      message.status !== "PENDING" ||
      (message.kind !== "APPROVAL" && message.kind !== "USER_INPUT_PROMPT")
    ) {
      continue
    }
    if (message.requestId) {
      const key = serverRequestKey(threadId, message.requestId)
      const pending = pendingServerRequests.get(key)
      pending?.runtime.rejectServerRequest(
        pending.rpcId,
        -32000,
        `Server request expired: ${reason}`,
      )
      pendingServerRequests.delete(key)
    }
    const updated = updateRuntimeMessage(threadId, message.id, {
      completedAt: new Date(),
      metadataPatch: {
        expiredAt: new Date().toISOString(),
        reason,
        status: "expired",
      },
      status: "COMPLETED",
    })
    if (updated) {
      emit(threadId, "message.updated", updated)
    }
  }
}

function settleOpenRunTimelineMessages(
  threadId: string,
  runId: string,
  status: Extract<ChatMessageResponse["status"], "COMPLETED" | "FAILED">,
): void {
  const state = runtimeStates.get(threadId)
  if (!state) {
    return
  }
  for (const message of state.messages) {
    if (
      message.runId !== runId ||
      (message.status !== "PENDING" && message.status !== "STREAMING") ||
      ![
        "COMMAND_EXECUTION",
        "FILE_CHANGE",
        "PLAN",
        "THINKING",
        "TOOL_ACTIVITY",
      ].includes(message.kind)
    ) {
      continue
    }
    const updated = updateRuntimeMessage(threadId, message.id, {
      completedAt: new Date(),
      status,
    })
    if (updated) {
      emit(threadId, "message.updated", updated)
    }
  }
}

function runHasPlanResult(threadId: string, runId: string): boolean {
  const state = runtimeStates.get(threadId)
  return (
    state?.messages.some((message) => {
      if (message.runId !== runId) {
        return false
      }
      const content = message.content.trim()
      if (!content || content === "Planning...") {
        return false
      }
      if (message.kind === "CHAT" && message.role === "ASSISTANT") {
        return /<proposed_plan\b[^>]*>[\s\S]*?<\/proposed_plan>/i.test(content)
      }
      return message.kind === "PLAN" && asJsonObject(message.metadata)?.presentation === "result"
    }) ?? false
  )
}

async function resolvePendingServerRequestsForFullAccess(
  threadId: string,
): Promise<void> {
  const pendingRequests = [...pendingServerRequests.values()].filter(
    (pending) =>
      pending.threadId === threadId && pending.requestKind !== "userInput",
  )
  for (const pending of pendingRequests) {
    if (pending.requestKind === "userInput") {
      continue
    }
    const requestKind = pending.requestKind
    const result = fullAccessServerRequestResult(requestKind)
    pending.runtime.respondToServerRequest(pending.rpcId, result)
    pendingServerRequests.delete(serverRequestKey(threadId, pending.requestId))
    const updated = updateRuntimeMessage(threadId, pending.messageId, {
      completedAt: new Date(),
      metadataPatch: {
        autoApproved: true,
        decision:
          requestKind === "approval" ? "acceptForSession" : undefined,
        resolvedAt: new Date().toISOString(),
        result,
        status: "resolved",
      },
      status: "COMPLETED",
    })
    if (updated) {
      emit(threadId, "message.updated", updated)
    }
  }
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
  runtime: Pick<CodexRuntimeSession, "request">,
  threadId: string,
  turnId?: string,
): Promise<string | null> {
  try {
    const response = await runtime.request(
      "thread/turns/list",
      { limit: 20, threadId },
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
    .filter(
      (line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`),
    )
    .length
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
    remainingPercent: Math.max(0, 100 - usedPercent),
    tokenLimit: resolvedTokenLimit,
    tokensRemaining: remainingTokens,
    tokensUsed,
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
      selectionLimit:
        readNumber(entry.selectionLimit) ?? readNumber(entry.selection_limit),
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
  return { permissions: true, scope: "session" }
}

function serverRequestKey(threadId: string, requestId: string): string {
  return `${threadId}:${requestId}`
}

function readJsonObjectArray(value: unknown): JsonObject[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  return value
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => !!entry)
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

function toSerializable(value: unknown): JsonSerializable {
  return JSON.parse(JSON.stringify(value)) as JsonSerializable
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
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

function normalizeChatTitle(value: string): string | null {
  const title = value.replace(/\s+/g, " ").trim()
  return title ? title.slice(0, 160) : null
}

function normalizeTitleComparisonValue(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? ""
}

function resolveChatDisplayTitle({
  preferenceTitle,
  preview,
  seed,
  snapshotTitle,
}: {
  preferenceTitle?: string | null
  preview?: string | null
  seed?: string | null
  snapshotTitle?: string | null
}): string {
  for (const candidate of [preferenceTitle, snapshotTitle]) {
    const title = normalizeChatTitle(candidate ?? "")
    if (title && !isGenericChatTitle(title)) {
      return title
    }
  }

  return (
    fallbackChatTitle(seed ?? "") ??
    fallbackChatTitle(preview ?? "") ??
    DEFAULT_CHAT_TITLE
  )
}

function isGenericChatTitle(value: string | null | undefined): boolean {
  const normalized = normalizeTitleComparisonValue(value)
  return (
    !normalized ||
    normalized === "untitled chat" ||
    normalized === "conversation" ||
    normalized === "new chat" ||
    normalized === "new thread" ||
    normalized === "chat" ||
    normalized === "codex chat"
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

function lastUserMessageContent(messages: ChatMessageResponse[]): string | null {
  return (
    [...messages]
      .reverse()
      .find((message) => message.role === "USER" && message.content.trim())
      ?.content ?? null
  )
}

function emit<TType extends ChatEventType>(
  threadId: string,
  type: TType,
  payload: ChatEventPayloads[TType],
): void {
  publishChatEvent(threadId, type, payload)
}

function logProjectionError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.stack ?? error.message : error)
}

function runtimeForAccount(account: CodexAccount): CodexRuntimeSession {
  return codexRuntimeService.getRuntime({
    accountId: account.id,
    args: normalizeAccountArgs(account.args),
    command: account.command,
    environment: normalizeEnvironment(account.environment),
    workingDirectory: null,
  })
}

function normalizeAccountArgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ["app-server"]
  }
  return value.filter((entry): entry is string => typeof entry === "string")
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

function extractThreadTitleFromObject(value: unknown): string | null {
  const object = asJsonObject(value)
  if (!object) {
    return null
  }
  const explicitNameCandidates = [
    object.threadName,
    object.thread_name,
    object.name,
  ]
  for (const candidate of explicitNameCandidates) {
    const title = normalizeChatTitle(readString(candidate) ?? "")
    if (title) {
      return title
    }
  }
  const title = normalizeChatTitle(readString(object.title) ?? "")
  if (title && !isGenericChatTitle(title)) {
    return title
  }
  const thread = asJsonObject(object.thread)
  return thread ? extractThreadTitleFromObject(thread) : null
}

function scheduleAutomaticChatTitleIfNeeded({
  cwd,
  runtime,
  seed,
  threadId,
}: {
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
  void (async () => {
    if (fallbackTitle) {
      await applyAutomaticThreadTitleIfAllowed(runtime, threadId, fallbackTitle)
    }
    const generatedTitle = await generatedChatTitleOrNull(runtime, {
      cwd,
      seed: trimmedSeed,
    })
    if (generatedTitle) {
      await applyAutomaticThreadTitleIfAllowed(runtime, threadId, generatedTitle)
    }
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
      readString(result?.name) ??
        readString(result?.threadName) ??
        readString(result?.thread_name) ??
        readString(result?.title) ??
        "",
    )
  } catch {
    return null
  }
}

async function applyAutomaticThreadTitleIfAllowed(
  runtime: Pick<CodexRuntimeSession, "request">,
  threadId: string,
  title: string,
): Promise<boolean> {
  const normalizedTitle = normalizeChatTitle(title)
  if (!normalizedTitle || isGenericChatTitle(normalizedTitle)) {
    return false
  }
  const preference = await getThreadPreference(threadId)
  if (preference?.title && !isGenericChatTitle(preference.title)) {
    return false
  }
  await updateThreadTitleFromCodex(threadId, normalizedTitle)
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

async function persistThreadTitleToCodex(
  threadId: string,
  preference: ThreadPreference,
  title: string,
): Promise<void> {
  if (!preference.accountId) {
    return
  }
  const account = await prisma.codexAccount.findUnique({
    where: { id: preference.accountId },
  })
  if (!account || account.status !== "CONNECTED") {
    return
  }
  await sendThreadNameSet(runtimeForAccount(account), threadId, title)
}

async function refreshThreadTitleFromCodex(
  runtime: Pick<CodexRuntimeSession, "request">,
  threadId: string,
): Promise<void> {
  const title = await readThreadTitleFromCodex(runtime, threadId)
  if (title) {
    await updateThreadTitleFromCodex(threadId, title)
  }
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
    const title = extractThreadTitleFromObject(response.result)
    if (title) {
      return title
    }
  } catch {
    // Fall back to thread/list.
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
      readJsonObjectArray(result?.data) ??
      readJsonObjectArray(result?.items) ??
      readJsonObjectArray(result?.threads) ??
      []
    const thread = rows.find((row) => readString(row.id) === threadId)
    return extractThreadTitleFromObject(thread)
  } catch {
    return null
  }
}

async function updateThreadTitleFromCodex(
  threadId: string,
  title: string,
): Promise<void> {
  const normalizedTitle = normalizeChatTitle(title)
  if (!normalizedTitle || isGenericChatTitle(normalizedTitle)) {
    return
  }
  const preference = await upsertThreadPreference(threadId, { title: normalizedTitle })
  emit(threadId, "chat.updated", await buildChatResponse(threadId, preference))
}

export const __testing = {
  approvalMetadata,
  extractAssistantText,
  extractThreadName,
  requestMethodKind,
  serverRequestResult,
  threadModeOverrides,
  turnModeOverrides,
  userInputMetadata,
}
