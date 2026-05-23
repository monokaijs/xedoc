import "dotenv/config"
import { constants } from "node:fs"
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { PrismaClient, type Prisma } from "@prisma/client"
import type { ContextWindowUsagePayload, JsonObject, MessageKind } from "@/types"
import {
  ensureAccountCodexHome,
  resolveCodexSharedChatHome,
  resolveCodexSharedSessionIndexPath,
  resolveCodexSharedStateDatabasePath,
} from "./codex-runtime.server"
import { asJsonObject, readString } from "./json.server"
import { prisma } from "./prisma.server"

export type ImportedLocalMessage = {
  content: string
  createdAt: Date
  kind?: MessageKind
  metadata: JsonObject
  rawPayload: JsonObject
  role: "ASSISTANT" | "SYSTEM" | "USER"
}

export type ParsedLocalCodexSession = {
  createdAt: Date
  externalThreadId: string
  messages: ImportedLocalMessage[]
  originator?: string
  path: string
  source?: string
  title: string
  updatedAt: Date
  workingDirectory?: string
}

export type LocalCodexSessionSummary = {
  createdAt: Date
  externalThreadId: string
  firstUserMessage?: string | null
  path: string
  preview?: string | null
  title: string | null
  updatedAt: Date
  workingDirectory?: string
}

type LocalCodexSessionFile = {
  mtimeMs: number
  path: string
}

export type LocalCodexSessionIndexMetadata = {
  title: string | null
  updatedAt: Date | null
}

type LocalImportState = {
  lastScanAt: number
  promise?: Promise<void>
}

type FileCacheEntry<T> = {
  mtimeMs: number
  size: number
  value: T
}

type CodexStateThreadRow = {
  archived: number | null
  archivedAt: number | null
  createdAt: number | string | bigint | null
  cwd: string | null
  firstUserMessage: string | null
  id: string
  preview: string | null
  rolloutPath: string | null
  title: string | null
  updatedAt: number | string | bigint | null
}

type SqliteTableColumn = {
  name: string
}

const globalForCodexState = globalThis as typeof globalThis & {
  codexStateDatabasePath?: string
  codexStatePrisma?: PrismaClient
}

const DEFAULT_SCAN_INTERVAL_MS = 30_000
const DEFAULT_MAX_FILES = 1_000
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
const FILE_CACHE_MAX_ENTRIES = 100
const GLOBAL_IMPORT_STATE_KEY = "global"
const importStates = new Map<string, LocalImportState>()
const contextUsageFileCache = new Map<
  string,
  FileCacheEntry<ContextWindowUsagePayload | null>
>()
const transcriptFileCache = new Map<
  string,
  FileCacheEntry<ParsedLocalCodexSession | null>
>()

export async function importLocalCodexChats(
  options: { force?: boolean } = {},
): Promise<void> {
  if (!localImportEnabled()) {
    return
  }

  const now = Date.now()
  const state = importStates.get(GLOBAL_IMPORT_STATE_KEY)
  if (
    !options.force &&
    state &&
    now - state.lastScanAt < localImportScanIntervalMs()
  ) {
    await state.promise
    return
  }

  if (state?.promise) {
    await state.promise
    return
  }

  const nextState: LocalImportState = { lastScanAt: now }
  const promise = scanAndImportLocalCodexChats()
    .catch((error) => {
      console.warn(
        "Local Codex chat import failed.",
        error instanceof Error ? error.message : error,
      )
    })
    .finally(() => {
      const current = importStates.get(GLOBAL_IMPORT_STATE_KEY)
      if (current?.promise === promise) {
        current.promise = undefined
      }
    })
  nextState.promise = promise
  importStates.set(GLOBAL_IMPORT_STATE_KEY, nextState)
  await promise
  await repairImportedLocalCodexChats()
}

export async function mirrorCodexSessionForAccount(
  threadId: string,
  accountId: string,
): Promise<void> {
  const sessionPath = await findLocalCodexSessionPath(threadId)
  if (!sessionPath) {
    return
  }

  const destination = join(
    ensureAccountCodexHome(accountId),
    "sessions",
    sessionRelativePath(sessionPath),
  )
  if (resolve(sessionPath) === resolve(destination)) {
    return
  }
  await mirrorSessionIndex(sessionPath)
  try {
    await access(destination, constants.R_OK)
    return
  } catch {
    // Copy below when the selected account does not already have the session.
  }

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFile(sessionPath, destination)
}

async function mirrorSessionIndex(sessionPath: string): Promise<void> {
  const indexPath = localSessionIndexPath(sessionPath)
  const destination = resolveCodexSharedSessionIndexPath()
  if (!indexPath || resolve(indexPath) === resolve(destination)) {
    return
  }
  try {
    const content = await readFile(indexPath, "utf8")
    if (!content.trim()) {
      return
    }
    const destinationContent = await readFile(destination, "utf8").catch(() => "")
    const prefix =
      destinationContent && !destinationContent.endsWith("\n") ? "\n" : ""
    await appendFile(
      destination,
      `${prefix}${content.endsWith("\n") ? content : `${content}\n`}`,
    )
  } catch {
    // The session file itself is enough for transcript import; index mirroring is best effort.
  }
}

export async function readLocalCodexSessionTranscriptForChat(
  chatId: string,
  threadId: string,
): Promise<ParsedLocalCodexSession | null> {
  void chatId
  const sessionPath = await findLocalCodexSessionPath(threadId)
  return sessionPath
    ? readLocalCodexSessionTranscriptFile(sessionPath, threadId)
    : null
}

export async function readLatestLocalCodexContextUsageForChat(
  chatId: string,
  threadId: string,
): Promise<ContextWindowUsagePayload | null> {
  void chatId
  const sessionPath = await findLocalCodexSessionPath(threadId)
  return sessionPath
    ? readLatestLocalCodexContextUsageFile(sessionPath, threadId)
    : null
}

export async function readLocalCodexSessionTranscript(
  threadId: string,
): Promise<ParsedLocalCodexSession | null> {
  const sessionPath = await findLocalCodexSessionPath(threadId)
  return sessionPath
    ? readLocalCodexSessionTranscriptFile(sessionPath, threadId)
    : null
}

export async function readLatestLocalCodexContextUsage(
  threadId: string,
): Promise<ContextWindowUsagePayload | null> {
  const sessionPath = await findLocalCodexSessionPath(threadId)
  return sessionPath
    ? readLatestLocalCodexContextUsageFile(sessionPath, threadId)
    : null
}

export async function readLocalCodexSessionMetadata(
  threadId: string,
): Promise<LocalCodexSessionSummary | null> {
  const row = await readCodexStateThread(threadId)
  return row ? summaryFromCodexStateThread(row) : null
}

export async function listLocalCodexSessionSummaries(): Promise<
  LocalCodexSessionSummary[]
> {
  const rows = await readCodexStateThreads(localImportMaxFiles())
  return rows.map(summaryFromCodexStateThread).sort(
    (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
  )
}

async function scanAndImportLocalCodexChats(): Promise<void> {
  const roots = await existingSessionRoots()
  if (!roots.length) {
    return
  }

  const files = (
    await Promise.all(roots.map((root) => listSessionFiles(root)))
  )
    .flat()
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, localImportMaxFiles())
  const existingThreadIds = await readExistingPathThreadIds(files)

  for (const file of files) {
    const pathThreadId = extractSessionIdFromPath(file.path)
    if (pathThreadId && existingThreadIds.has(pathThreadId)) {
      continue
    }
    await importSessionFile(file.path).catch((error) => {
      console.warn(
        `Failed to import local Codex chat from ${file.path}.`,
        error instanceof Error ? error.message : error,
      )
    })
  }
}

async function readExistingPathThreadIds(
  files: LocalCodexSessionFile[],
): Promise<Set<string>> {
  const threadIds = files
    .map((file) => extractSessionIdFromPath(file.path))
    .filter((threadId): threadId is string => !!threadId)
  if (!threadIds.length) {
    return new Set()
  }
  const chats = await prisma.chat.findMany({
    where: { externalThreadId: { in: [...new Set(threadIds)] } },
    select: { externalThreadId: true },
  })
  return new Set(
    chats
      .map((chat) => chat.externalThreadId)
      .filter((threadId): threadId is string => !!threadId),
  )
}

async function importSessionFile(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isFile() || info.size > localImportMaxFileBytes()) {
    return
  }

  const parsed = parseLocalCodexSessionJsonl(
    await readFile(path, "utf8"),
    path,
    new Date(info.mtimeMs),
  )
  if (!parsed || parsed.originator === "xedoc") {
    return
  }
  const indexedMetadata = await readLocalSessionIndexMetadata(
    path,
    parsed.externalThreadId,
  )
  const lastActivityAt = indexedMetadata?.updatedAt ?? parsed.updatedAt

  await prisma.$transaction(async (tx) => {
    const existing = await tx.chat.findFirst({
      where: {
        externalThreadId: parsed.externalThreadId,
      },
      select: { id: true },
    })
    if (existing) {
      await repairImportedLocalCodexChat(
        tx,
        existing.id,
        indexedMetadata,
        parsed.updatedAt,
      )
      return
    }

    await tx.chat.create({
      data: {
        accountId: null,
        createdAt: parsed.createdAt,
        externalThreadId: parsed.externalThreadId,
        lastActivityAt,
        status: "IDLE",
        title: indexedMetadata?.title ?? parsed.title,
        updatedAt: parsed.updatedAt,
        workingDirectory: parsed.workingDirectory,
      },
    })
  })
}

function parseLocalCodexSessionJsonl(
  content: string,
  path: string,
  fallbackTimestamp: Date,
): ParsedLocalCodexSession | null {
  let sessionId: string | undefined
  let source: string | undefined
  let originator: string | undefined
  let workingDirectory: string | undefined
  let createdAt: Date | undefined
  let updatedAt: Date | undefined
  const responseMessages: ImportedLocalMessage[] = []
  const eventMessages: ImportedLocalMessage[] = []

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }
    const timestamp = readDate(record.timestamp) ?? fallbackTimestamp
    createdAt = earlierDate(createdAt, timestamp)
    updatedAt = laterDate(updatedAt, timestamp)
    const payload = asJsonObject(record.payload)

    if (record.type === "session_meta" && payload) {
      sessionId = readString(payload.id) ?? sessionId
      source = readString(payload.source) ?? source
      originator = readString(payload.originator) ?? originator
      workingDirectory = readString(payload.cwd) ?? workingDirectory
      createdAt = readDate(payload.timestamp) ?? createdAt
      continue
    }

    if (record.type === "turn_context" && payload) {
      workingDirectory = readString(payload.cwd) ?? workingDirectory
      continue
    }

    const responseMessage = importedResponseMessage(record, timestamp, {
      originator,
      path,
      sessionId,
      source,
    })
    if (responseMessage) {
      responseMessages.push(responseMessage)
      continue
    }

    const eventMessage = importedEventMessage(record, timestamp, {
      originator,
      path,
      sessionId,
      source,
    })
    if (eventMessage) {
      eventMessages.push(eventMessage)
    }
  }

  const messages = responseMessages.length ? responseMessages : eventMessages
  const externalThreadId = sessionId ?? extractSessionIdFromPath(path)
  if (!externalThreadId || !messages.length) {
    return null
  }

  const firstUserMessage = messages.find((message) => message.role === "USER")
  const title =
    fallbackChatTitle(firstUserMessage?.content ?? "") ??
    fallbackChatTitle(messages[0]?.content ?? "") ??
    "Imported Codex chat"

  return {
    createdAt: createdAt ?? fallbackTimestamp,
    externalThreadId,
    messages,
    originator,
    path,
    source,
    title,
    updatedAt: updatedAt ?? fallbackTimestamp,
    workingDirectory,
  }
}

async function repairImportedLocalCodexChats(): Promise<void> {
  const chats = await prisma.chat.findMany({
    where: {
      messages: {
        some: {
          metadata: {
            path: "$.kind",
            equals: "localCodexImport",
          },
        },
      },
    },
    select: { id: true },
    take: localImportMaxFiles(),
  })

  for (const chat of chats) {
    await prisma.$transaction((tx) => repairImportedLocalCodexChat(tx, chat.id))
  }
}

async function repairImportedLocalCodexChat(
  tx: Prisma.TransactionClient,
  chatId: string,
  indexedMetadata?: LocalCodexSessionIndexMetadata | null,
  fallbackLastActivityAt?: Date | null,
): Promise<void> {
  const chat = await tx.chat.findUnique({
    where: { id: chatId },
    select: { externalThreadId: true, id: true, lastActivityAt: true, title: true },
  })
  if (!chat) {
    return
  }

  const messages = await tx.chatMessage.findMany({
    where: { chatId },
    orderBy: { sequence: "asc" },
    select: {
      content: true,
      id: true,
      metadata: true,
      role: true,
    },
  })
  const importedMessages = messages.filter((message) => {
    const metadata = asJsonObject(message.metadata)
    return metadata?.kind === "localCodexImport"
  })
  const pseudoMessageIds = importedMessages
    .filter(
      (message) =>
        message.role === "USER" && isInternalEnvironmentContext(message.content),
    )
    .map((message) => message.id)
  if (pseudoMessageIds.length) {
    await tx.chatMessage.deleteMany({
      where: { id: { in: pseudoMessageIds } },
    })
  }

  const remaining = messages.filter(
    (message) => !pseudoMessageIds.includes(message.id),
  )
  const titleSeed =
    remaining.find(
      (message) =>
        message.role === "USER" && !isInternalEnvironmentContext(message.content),
    )?.content ??
    remaining.find((message) => !isInternalEnvironmentContext(message.content))
      ?.content ??
    ""
  const fallbackTitle = fallbackChatTitle(titleSeed) ?? "Imported Codex chat"
  const sourceMetadata =
    indexedMetadata ??
    (chat.externalThreadId
      ? await readSourceSessionIndexMetadata(chat.externalThreadId)
      : null)
  const sourceTitle = sourceMetadata?.title ?? null
  const sourceUpdatedAt = sourceMetadata?.updatedAt ?? fallbackLastActivityAt ?? null
  const currentTitle = normalizeTitleComparisonValue(chat.title)
  const data: Prisma.ChatUpdateInput = {}
  if (
    sourceUpdatedAt &&
    chat.lastActivityAt.getTime() !== sourceUpdatedAt.getTime()
  ) {
    data.lastActivityAt = sourceUpdatedAt
  }
  if (sourceTitle) {
    if (currentTitle !== normalizeTitleComparisonValue(sourceTitle)) {
      data.title = sourceTitle
    }
  } else {
    const autoTitles = new Set([
      normalizeTitleComparisonValue(fallbackTitle),
      normalizeTitleComparisonValue("Imported Codex chat"),
    ])
    const canUseFallbackTitle =
      isInternalEnvironmentContext(chat.title) ||
      autoTitles.has(currentTitle) ||
      !currentTitle
    if (canUseFallbackTitle) {
      data.title = fallbackTitle
    }
  }

  if (Object.keys(data).length) {
    await tx.chat.update({
      where: { id: chat.id },
      data,
    })
  }
}

function importedResponseMessage(
  record: JsonObject,
  timestamp: Date,
  session: {
    originator?: string
    path: string
    sessionId?: string
    source?: string
  },
): ImportedLocalMessage | null {
  if (record.type !== "response_item") {
    return null
  }
  const payload = asJsonObject(record.payload)
  if (!payload || payload.type !== "message") {
    return null
  }
  const role = importedRole(payload.role)
  if (!role) {
    return null
  }
  const content = extractMessageContent(payload)
  if (!content.trim() || isInternalEnvironmentContext(content)) {
    return null
  }
  return {
    content,
    createdAt: timestamp,
    metadata: importedMessageMetadata(payload, session),
    rawPayload: compactRawPayload(record, payload),
    role,
  }
}

async function readSourceSessionIndexMetadata(
  threadId: string,
): Promise<LocalCodexSessionIndexMetadata | null> {
  const sessionPath = await findLocalCodexSessionPath(threadId)
  return sessionPath
    ? readLocalSessionIndexMetadata(sessionPath, threadId)
    : null
}

function importedEventMessage(
  record: JsonObject,
  timestamp: Date,
  session: {
    originator?: string
    path: string
    sessionId?: string
    source?: string
  },
): ImportedLocalMessage | null {
  if (record.type !== "event_msg") {
    return null
  }
  const payload = asJsonObject(record.payload)
  if (!payload) {
    return null
  }
  const payloadType = readString(payload.type)
  const role =
    payloadType === "user_message"
      ? "USER"
      : payloadType === "agent_message"
        ? "ASSISTANT"
        : isCompactionPayloadType(payloadType)
          ? "SYSTEM"
          : null
  if (!role) {
    return null
  }
  const content =
    role === "SYSTEM"
      ? compactionMessage(payloadType)
      : typeof payload.message === "string"
        ? appendImageTags(payload.message, payload)
        : ""
  if (!content.trim() || isInternalEnvironmentContext(content)) {
    return null
  }
  return {
    content,
    createdAt: timestamp,
    kind: role === "SYSTEM" ? "TOOL_ACTIVITY" : undefined,
    metadata: {
      ...importedMessageMetadata(payload, session),
      ...(role === "SYSTEM" ? { eventKind: "contextCompaction" } : {}),
    },
    rawPayload: compactRawPayload(record, payload),
    role,
  }
}

function importedRole(value: unknown): "ASSISTANT" | "USER" | null {
  if (value === "assistant") {
    return "ASSISTANT"
  }
  if (value === "user") {
    return "USER"
  }
  return null
}

function isCompactionPayloadType(value: string | undefined): boolean {
  const normalized = value?.replace(/[^a-z0-9]+/gi, "").toLowerCase() ?? ""
  return normalized.includes("compact") || normalized.includes("compaction")
}

function compactionMessage(value: string | undefined): string {
  const normalized = value?.replace(/[_-]+/g, " ").trim().toLowerCase()
  if (normalized?.includes("start")) {
    return "Context compaction started."
  }
  if (normalized?.includes("finish") || normalized?.includes("complete")) {
    return "Context compacted."
  }
  return "Context compaction recorded."
}

export function isInternalEnvironmentContext(content: string): boolean {
  const normalized = content
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
  return (
    normalized.startsWith("<environment context>") ||
    normalized.startsWith("environment context") ||
    normalized.startsWith("environmentcontext")
  )
}

function importedMessageMetadata(
  payload: JsonObject,
  session: {
    originator?: string
    path: string
    sessionId?: string
    source?: string
  },
): JsonObject {
  return {
    kind: "localCodexImport",
    originator: session.originator,
    phase: readString(payload.phase),
    sessionId: session.sessionId,
    sessionPath: session.path,
    source: session.source,
    sourcePayloadType: readString(payload.type),
  }
}

function compactRawPayload(record: JsonObject, payload: JsonObject): JsonObject {
  return {
    payload: {
      name: readString(payload.name),
      phase: readString(payload.phase),
      role: readString(payload.role),
      type: readString(payload.type),
    },
    timestamp: readString(record.timestamp),
    type: readString(record.type),
  }
}

function extractMessageContent(payload: JsonObject): string {
  if (typeof payload.text === "string") {
    return appendImageTags(payload.text, payload)
  }
  if (typeof payload.message === "string") {
    return appendImageTags(payload.message, payload)
  }
  if (typeof payload.content === "string") {
    return appendImageTags(payload.content, payload)
  }
  if (!Array.isArray(payload.content)) {
    return appendImageTags("", payload)
  }
  const content = payload.content
    .map((entry) => {
      if (typeof entry === "string") {
        return entry
      }
      const object = asJsonObject(entry)
      if (!object) {
        return ""
      }
      return typeof object.text === "string"
        ? object.text
        : imageTagFromObject(object) ?? ""
    })
    .join("")
  return appendImageTags(content, payload)
}

function appendImageTags(content: string, payload: JsonObject): string {
  const tags = [
    ...imageTagsFromArray(payload.images),
    ...imageTagsFromArray(payload.local_images),
    ...imageTagsFromArray(payload.localImages),
  ]
  return [content, ...tags].filter(Boolean).join("\n\n")
}

function imageTagsFromArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) =>
      typeof entry === "string" ? imageTagFromSource(entry) : imageTagFromObject(asJsonObject(entry)),
    )
    .filter((entry): entry is string => !!entry)
}

function imageTagFromObject(object: JsonObject | undefined): string | null {
  if (!object) {
    return null
  }
  return imageTagFromSource(
    readString(object.url) ??
      readString(object.image_url) ??
      readString(object.path) ??
      readString(object.filePath),
  )
}

function imageTagFromSource(value: string | undefined): string | null {
  const src = value?.trim()
  if (!src) {
    return null
  }
  return `<image>${src}</image>`
}

export async function readLocalSessionIndexMetadata(
  sessionPath: string,
  sessionId: string,
): Promise<LocalCodexSessionIndexMetadata | null> {
  if (!sessionPath || !sessionId) {
    return null
  }
  const indexPath = localSessionIndexPath(sessionPath)
  if (!indexPath) {
    return null
  }
  try {
    return readSessionIndexMetadata(await readFile(indexPath, "utf8"), sessionId)
  } catch {
    return null
  }
}

export async function readCodexSessionIndexFile(
  indexPath: string,
): Promise<Map<string, LocalCodexSessionIndexMetadata>> {
  try {
    return readSessionIndex(await readFile(indexPath, "utf8"))
  } catch {
    return new Map()
  }
}

function localSessionIndexPath(sessionPath: string): string | null {
  const marker = `${sep}sessions${sep}`
  const resolvedPath = resolve(sessionPath)
  const markerIndex = resolvedPath.lastIndexOf(marker)
  if (markerIndex === -1) {
    return null
  }
  return join(resolvedPath.slice(0, markerIndex), "session_index.jsonl")
}

function readSessionIndexMetadata(
  content: string,
  sessionId: string,
): LocalCodexSessionIndexMetadata | null {
  return readSessionIndex(content).get(sessionId) ?? null
}

function readSessionIndex(
  content: string,
): Map<string, LocalCodexSessionIndexMetadata> {
  const entries = new Map<string, LocalCodexSessionIndexMetadata>()
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    const record = parseJsonObject(line)
    if (!record) {
      continue
    }
    const rowId =
      readString(record.id) ??
      readString(record.thread_id) ??
      readString(record.threadId) ??
      readString(record.session_id) ??
      readString(record.sessionId)
    if (!rowId) {
      continue
    }
    const rowTitle = normalizeImportedTitle(
      readString(record.thread_name) ??
        readString(record.threadName) ??
        readString(record.name) ??
        readString(record.title),
    )
    const updatedAt =
      readDate(record.updated_at) ??
      readDate(record.updatedAt) ??
      readDate(record.modified_at) ??
      readDate(record.modifiedAt) ??
      null
    const existing = entries.get(rowId)
    entries.set(rowId, {
      title: rowTitle ?? existing?.title ?? null,
      updatedAt: updatedAt ?? existing?.updatedAt ?? null,
    })
  }
  return entries
}

function normalizeImportedTitle(
  value: string | null | undefined,
  options: { allowGeneric?: boolean } = {},
): string | null {
  const title = value?.replace(/\s+/g, " ").trim()
  if (
    !title ||
    isInternalEnvironmentContext(title) ||
    (!options.allowGeneric && isGenericImportedTitle(title))
  ) {
    return null
  }
  return title.slice(0, 160)
}

function isGenericImportedTitle(value: string): boolean {
  const normalized = normalizeTitleComparisonValue(value)
  return (
    normalized === "untitled chat" ||
    normalized === "conversation" ||
    normalized === "new chat" ||
    normalized === "new thread" ||
    normalized === "chat" ||
    normalized === "codex chat"
  )
}

async function readCodexStateThreads(limit: number): Promise<CodexStateThreadRow[]> {
  const client = await codexStateClient()
  if (!client) {
    return []
  }
  try {
    const columns = await readCodexStateThreadColumns(client)
    return await client.$queryRawUnsafe<CodexStateThreadRow[]>(
      `
        SELECT ${codexStateThreadSelectSql(columns)}
        FROM threads
        ${codexStateThreadWhereSql(columns)}
        ORDER BY ${codexStateThreadUpdatedAtColumn(columns)} DESC
        LIMIT ?
      `,
      limit,
    )
  } catch (error) {
    console.warn(
      "Failed to read root Codex thread database.",
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

async function readCodexStateThread(
  threadId: string,
): Promise<CodexStateThreadRow | null> {
  const client = await codexStateClient()
  if (!client) {
    return null
  }
  try {
    const columns = await readCodexStateThreadColumns(client)
    const rows = await client.$queryRawUnsafe<CodexStateThreadRow[]>(
      `
        SELECT ${codexStateThreadSelectSql(columns)}
        FROM threads
        WHERE id = ?
        LIMIT 1
      `,
      threadId,
    )
    return rows[0] ?? null
  } catch {
    return null
  }
}

async function readCodexStateThreadColumns(
  client: PrismaClient,
): Promise<Set<string>> {
  const rows = await client.$queryRawUnsafe<SqliteTableColumn[]>(
    "PRAGMA table_info(threads)",
  )
  return new Set(rows.map((row) => row.name))
}

function codexStateThreadSelectSql(columns: Set<string>): string {
  return [
    codexStateColumnSql(columns, "id"),
    codexStateColumnSql(columns, "rollout_path", "rolloutPath"),
    codexStateDateColumnSql(
      columns,
      columns.has("created_at_ms") ? "created_at_ms" : "created_at",
      "createdAt",
    ),
    codexStateDateColumnSql(
      columns,
      codexStateThreadUpdatedAtColumn(columns),
      "updatedAt",
    ),
    codexStateColumnSql(columns, "cwd"),
    codexStateColumnSql(columns, "title"),
    codexStateColumnSql(columns, "first_user_message", "firstUserMessage"),
    codexStateColumnSql(columns, "preview"),
    codexStateColumnSql(columns, "archived"),
    codexStateColumnSql(columns, "archived_at", "archivedAt"),
  ].join(",\n          ")
}

function codexStateColumnSql(
  columns: Set<string>,
  column: string,
  alias?: string,
): string {
  return columns.has(column)
    ? `${column}${alias ? ` AS ${alias}` : ""}`
    : `NULL AS ${alias ?? column}`
}

function codexStateDateColumnSql(
  columns: Set<string>,
  column: string,
  alias: string,
): string {
  return columns.has(column) ? `CAST(${column} AS TEXT) AS ${alias}` : `NULL AS ${alias}`
}

function codexStateThreadWhereSql(columns: Set<string>): string {
  return columns.has("archived") ? "WHERE COALESCE(archived, 0) = 0" : ""
}

function codexStateThreadUpdatedAtColumn(columns: Set<string>): string {
  if (columns.has("updated_at_ms")) {
    return "updated_at_ms"
  }
  if (columns.has("updated_at")) {
    return "updated_at"
  }
  return "rowid"
}

async function codexStateClient(): Promise<PrismaClient | null> {
  const databasePath = resolveCodexSharedStateDatabasePath()
  try {
    await access(databasePath, constants.R_OK)
  } catch {
    return null
  }
  if (
    globalForCodexState.codexStatePrisma &&
    globalForCodexState.codexStateDatabasePath === databasePath
  ) {
    return globalForCodexState.codexStatePrisma
  }
  await globalForCodexState.codexStatePrisma?.$disconnect().catch(() => undefined)
  globalForCodexState.codexStateDatabasePath = databasePath
  globalForCodexState.codexStatePrisma = new PrismaClient({
    datasources: { db: { url: sqliteDatabaseUrl(databasePath) } },
  })
  return globalForCodexState.codexStatePrisma
}

function summaryFromCodexStateThread(
  row: CodexStateThreadRow,
): LocalCodexSessionSummary {
  const fallbackTimestamp = new Date(0)
  const updatedAt = dateFromCodexTimestamp(row.updatedAt, fallbackTimestamp)
  const createdAt = dateFromCodexTimestamp(row.createdAt, updatedAt)
  const path = rootCodexSessionPathCandidates(row.rolloutPath)[0] ?? ""
  const firstUserMessage = normalizeImportedTitle(row.firstUserMessage, {
    allowGeneric: true,
  })
  const preview = normalizeImportedTitle(row.preview, { allowGeneric: true })
  return {
    createdAt,
    externalThreadId: row.id,
    firstUserMessage,
    path,
    preview,
    title:
      normalizeImportedTitle(row.title, { allowGeneric: false }) ??
      fallbackChatTitle(firstUserMessage ?? "") ??
      fallbackChatTitle(preview ?? "") ??
      null,
    updatedAt,
    workingDirectory: row.cwd ?? undefined,
  }
}

function dateFromCodexTimestamp(
  value: number | string | bigint | null | undefined,
  fallback: Date,
): Date {
  const numeric =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : Number.NaN
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback
  }
  return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
}

function sqliteDatabaseUrl(path: string): string {
  return `file:${path}?connection_limit=1&pool_timeout=30`
}

function rootCodexSessionPathCandidates(
  rolloutPath: string | null | undefined,
): string[] {
  const trimmed = rolloutPath?.trim()
  if (!trimmed) {
    return []
  }
  const sharedPath = join(
    resolveCodexSharedChatHome(),
    "sessions",
    sessionRelativePath(trimmed),
  )
  return [...new Set([trimmed, sharedPath])]
}

async function existingSessionRoots(): Promise<string[]> {
  const roots = [join(resolveCodexSharedChatHome(), "sessions")]
  const existing: string[] = []
  const seen = new Set<string>()
  for (const root of roots.map((entry) => resolveHomePath(entry))) {
    try {
      await access(root, constants.R_OK)
      const key = await realpath(root).catch(() => root)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      existing.push(root)
    } catch {
      // Missing Codex installs should not make chat listing fail.
    }
  }
  return existing
}

async function findLocalCodexSessionPath(threadId: string): Promise<string | null> {
  const row = await readCodexStateThread(threadId)
  for (const path of rootCodexSessionPathCandidates(row?.rolloutPath)) {
    try {
      await access(path, constants.R_OK)
      return path
    } catch {
      // Try the next root Codex path candidate.
    }
  }
  return null
}

async function readLocalCodexSessionTranscriptFile(
  path: string,
  threadId: string,
): Promise<ParsedLocalCodexSession | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > localImportMaxFileBytes()) {
      return null
    }
    const cacheKey = `${threadId}:${path}`
    const cached = transcriptFileCache.get(cacheKey)
    if (cached && fileCacheEntryMatches(cached, info)) {
      return cached.value
    }
    const parsed = parseLocalCodexSessionJsonl(
      await readFile(path, "utf8"),
      path,
      new Date(info.mtimeMs),
    )
    const result = parsed?.externalThreadId === threadId ? parsed : null
    setFileCacheEntry(transcriptFileCache, cacheKey, info, result)
    return result
  } catch {
    return null
  }
}

async function readLatestLocalCodexContextUsageFile(
  path: string,
  threadId: string,
): Promise<ContextWindowUsagePayload | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > localImportMaxFileBytes()) {
      return null
    }
    const cacheKey = `${threadId}:${path}`
    const cached = contextUsageFileCache.get(cacheKey)
    if (cached && fileCacheEntryMatches(cached, info)) {
      return cached.value
    }
    let latestUsage: ContextWindowUsagePayload | null = null
    let sessionId: string | undefined
    for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
      if (!line.trim()) {
        continue
      }
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      if (record.type === "session_meta") {
        const payload = asJsonObject(record.payload)
        sessionId = readString(payload?.id) ?? sessionId
      }
      const usage = localContextWindowUsageFromRecord(record)
      if (usage) {
        latestUsage = usage
      }
    }
    const matchedThreadId = sessionId ?? extractSessionIdFromPath(path)
    const result = matchedThreadId === threadId ? latestUsage : null
    setFileCacheEntry(contextUsageFileCache, cacheKey, info, result)
    return result
  } catch {
    return null
  }
}

async function listSessionFiles(root: string): Promise<LocalCodexSessionFile[]> {
  const files: LocalCodexSessionFile[] = []
  await walkSessionFiles(root, files, 0)
  return files
}

async function walkSessionFiles(
  directory: string,
  files: LocalCodexSessionFile[],
  depth: number,
): Promise<void> {
  if (depth > 6) {
    return
  }
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walkSessionFiles(path, files, depth + 1)
        return
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        return
      }
      const info = await stat(path)
      files.push({ mtimeMs: info.mtimeMs, path })
    }),
  )
}

function localImportEnabled(): boolean {
  if (process.env.NODE_ENV === "test") {
    return process.env.CODEX_LOCAL_CHAT_IMPORT === "true"
  }
  return process.env.CODEX_LOCAL_CHAT_IMPORT !== "false"
}

function localImportScanIntervalMs(): number {
  return readPositiveIntegerEnv(
    "CODEX_LOCAL_CHAT_IMPORT_INTERVAL_MS",
    DEFAULT_SCAN_INTERVAL_MS,
  )
}

function localImportMaxFiles(): number {
  return readPositiveIntegerEnv("CODEX_LOCAL_CHAT_IMPORT_MAX_FILES", DEFAULT_MAX_FILES)
}

function localImportMaxFileBytes(): number {
  return readPositiveIntegerEnv(
    "CODEX_LOCAL_CHAT_IMPORT_MAX_FILE_BYTES",
    DEFAULT_MAX_FILE_BYTES,
  )
}

function fileCacheEntryMatches<T>(
  entry: FileCacheEntry<T>,
  info: { mtimeMs: number; size: number },
): boolean {
  return entry.mtimeMs === info.mtimeMs && entry.size === info.size
}

function setFileCacheEntry<T>(
  cache: Map<string, FileCacheEntry<T>>,
  key: string,
  info: { mtimeMs: number; size: number },
  value: T,
): void {
  if (cache.size >= FILE_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) {
      cache.delete(oldestKey)
    }
  }
  cache.set(key, {
    mtimeMs: info.mtimeMs,
    size: info.size,
    value,
  })
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function localContextWindowUsageFromRecord(
  record: JsonObject,
): ContextWindowUsagePayload | null {
  const payload = findTokenCountPayload(record)
  if (!payload) {
    return null
  }
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

function contextWindowUsageFromObject(
  usageRoot: JsonObject,
  limitRoot = usageRoot,
): ContextWindowUsagePayload | null {
  const tokenLimit = firstPositiveInteger(limitRoot, [
    "model_context_window",
    "modelContextWindow",
    "context_window",
    "contextWindow",
    "inputTokenLimit",
    "input_token_limit",
    "maxContextTokens",
    "max_context_tokens",
    "tokenLimit",
    "token_limit",
  ])
  const explicitTotal = firstPositiveInteger(usageRoot, [
    "total_tokens",
    "totalTokens",
    "tokens_used",
    "tokensUsed",
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
  const usedPercent = Math.max(
    0,
    Math.min(100, Math.round((tokensUsed / resolvedTokenLimit) * 100)),
  )
  return {
    tokenLimit: resolvedTokenLimit,
    tokensRemaining: Math.max(0, resolvedTokenLimit - tokensUsed),
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
  const type = normalizeTokenPayloadKey(readString(object.type) ?? "")
  const method = normalizeTokenPayloadKey(readString(object.method) ?? "")
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

function normalizeTokenPayloadKey(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "").toLowerCase()
}

function parseJsonObject(line: string): JsonObject | null {
  try {
    return asJsonObject(JSON.parse(line)) ?? null
  } catch {
    return null
  }
}

function readDate(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function earlierDate(left: Date | undefined, right: Date): Date {
  return !left || right < left ? right : left
}

function laterDate(left: Date | undefined, right: Date): Date {
  return !left || right > left ? right : left
}

function extractSessionIdFromPath(path: string): string | undefined {
  return /rollout-.*?-([0-9a-f]{8,}[^/.]*)\.jsonl$/i.exec(path)?.[1]
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

function normalizeTitleComparisonValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

function resolveHomePath(path: string): string {
  if (path === "~") {
    return homedir()
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2))
  }
  return resolve(path)
}

function sessionRelativePath(path: string): string {
  const marker = `${sep}sessions${sep}`
  const markerIndex = path.lastIndexOf(marker)
  if (markerIndex === -1) {
    return basename(path)
  }
  return path.slice(markerIndex + marker.length)
}

export const __testing = {
  isInternalEnvironmentContext,
  parseLocalCodexSessionJsonl,
  readSessionIndexMetadata,
}
