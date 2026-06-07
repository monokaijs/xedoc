import "dotenv/config"
import { constants } from "node:fs"
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { PrismaClient, type Prisma } from "@prisma/client"
import type {
  ContextWindowUsagePayload,
  JsonObject,
  MessageKind,
  MessageStatus,
} from "@/types"
import {
  ensureAccountCodexHome,
  resolveAccountCodexStateDatabasePath,
  resolveCodexAccountsHome,
  resolveCodexHistoryHome,
  resolveCodexSharedChatHome,
} from "./codex-runtime.server"
import { asJsonObject, readString } from "./json.server"
import { prisma } from "./prisma.server"

export type ImportedLocalMessage = {
  completedAt?: Date | null
  content: string
  createdAt: Date
  itemId?: string
  kind?: MessageKind
  metadata: JsonObject
  rawPayload: JsonObject
  requestId?: string
  role: "ASSISTANT" | "SYSTEM" | "USER"
  status?: MessageStatus
  turnId?: string
}

export type ParsedLocalCodexSession = {
  activeStartedAt?: Date
  activeTurnId?: string
  createdAt: Date
  externalThreadId: string
  messages: ImportedLocalMessage[]
  originator?: string
  path: string
  source?: string
  status: "IDLE" | "RUNNING"
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

type LocalSessionMessageContext = {
  originator?: string
  path: string
  sessionId?: string
  source?: string
  suppressedToolOutputCallIds?: Set<string>
  turnId?: string
}

type OrderedImportedLocalMessage = ImportedLocalMessage & { order: number }

type LocalHistoryReadOptions = {
  refresh?: boolean
}

type LocalFunctionCallOutput = {
  output: string
  timestamp: Date
}

type CodexStateThreadRow = {
  archived: number | null
  archivedAt: number | string | bigint | null
  agentNickname: string | null
  agentPath: string | null
  agentRole: string | null
  approvalMode: string | null
  cliVersion: string | null
  createdAt: number | string | bigint | null
  createdAtMs: number | string | bigint | null
  cwd: string | null
  firstUserMessage: string | null
  gitBranch: string | null
  gitOriginUrl: string | null
  gitSha: string | null
  hasUserEvent: number | null
  id: string
  memoryMode: string | null
  model: string | null
  modelProvider: string | null
  preview: string | null
  reasoningEffort: string | null
  rolloutPath: string | null
  sandboxPolicy: string | null
  source: string | null
  threadSource: string | null
  title: string | null
  tokensUsed: number | null
  updatedAt: number | string | bigint | null
  updatedAtMs: number | string | bigint | null
}

type SqliteTableColumn = {
  name: string
}

const globalForCodexState = globalThis as typeof globalThis & {
  codexStateClients?: Map<string, PrismaClient>
}

type CanonicalThreadRecord = {
  index: LocalCodexSessionIndexMetadata | null
  sessionRelativePath: string
  state: CodexStateThreadRow
  syncedAt: string
}

const DEFAULT_SCAN_INTERVAL_MS = 30_000
const STALE_ACTIVE_SESSION_MS = 10 * 60 * 1000
const DEFAULT_MAX_FILES = 1_000
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
const FILE_CACHE_MAX_ENTRIES = 100
const ACCOUNT_HISTORY_SYNC_STATE_KEY = "accounts"
const GLOBAL_IMPORT_STATE_KEY = "global"
const importStates = new Map<string, LocalImportState>()
const threadHistoryLocks = new Map<string, Promise<void>>()
const contextUsageFileCache = new Map<
  string,
  FileCacheEntry<ContextWindowUsagePayload | null>
>()
const transcriptFileCache = new Map<
  string,
  FileCacheEntry<ParsedLocalCodexSession | null>
>()
let canonicalHistoryImportPromise: Promise<void> | null = null
let canonicalHistoryImported = false

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
  const promise = ensureCanonicalHistoryImported({ force: options.force })
    .then(() => scanAndImportLocalCodexChats())
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

export async function hydrateThreadForAccount(
  threadId: string,
  accountId: string,
): Promise<boolean> {
  await ensureCanonicalHistoryHome()
  return withThreadHistoryLock(threadId, () =>
    hydrateCanonicalThreadToAccount(threadId, accountId),
  )
}

export async function syncThreadFromAccount(
  threadId: string,
  accountId: string,
): Promise<boolean> {
  await ensureCanonicalHistoryHome()
  return withThreadHistoryLock(threadId, async () =>
    syncThreadFromCodexHome(threadId, ensureAccountCodexHome(accountId)),
  )
}

export async function syncAccountCodexHistories(
  options: { force?: boolean } = {},
): Promise<void> {
  const now = Date.now()
  const state = importStates.get(ACCOUNT_HISTORY_SYNC_STATE_KEY)
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
  const promise = ensureCanonicalHistoryHome()
    .then(async () => {
      for (const codexHome of await existingAccountCodexHistoryHomes()) {
        await syncCodexHomeHistory(codexHome).catch((error) => {
          console.warn(
            `Failed to sync Codex account history from ${codexHome}.`,
            error instanceof Error ? error.message : error,
          )
        })
      }
      canonicalHistoryImported = true
    })
    .finally(() => {
      const current = importStates.get(ACCOUNT_HISTORY_SYNC_STATE_KEY)
      if (current?.promise === promise) {
        current.promise = undefined
      }
    })
  nextState.promise = promise
  importStates.set(ACCOUNT_HISTORY_SYNC_STATE_KEY, nextState)
  await promise
}

async function sameRealPath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch {
    return false
  }
}

async function ensureCanonicalHistoryImported(
  options: { force?: boolean } = {},
): Promise<void> {
  if (canonicalHistoryImported && !options.force) {
    return
  }
  if (!canonicalHistoryImportPromise || options.force) {
    canonicalHistoryImportPromise = importCanonicalCodexHistory()
      .then(() => {
        canonicalHistoryImported = true
      })
      .finally(() => {
        canonicalHistoryImportPromise = null
      })
  }
  await canonicalHistoryImportPromise
}

async function ensureCanonicalHistoryForRead(
  options: LocalHistoryReadOptions = {},
): Promise<void> {
  if (options.refresh === false) {
    await ensureCanonicalHistoryHome()
    return
  }
  await ensureCanonicalHistoryImported()
}

async function importCanonicalCodexHistory(): Promise<void> {
  await ensureCanonicalHistoryHome()
  for (const codexHome of await existingAccountCodexHistoryHomes()) {
    await syncCodexHomeHistory(codexHome).catch((error) => {
      console.warn(
        `Failed to import Codex history from ${codexHome}.`,
        error instanceof Error ? error.message : error,
      )
    })
  }
}

async function syncCodexHomeHistory(codexHome: string): Promise<void> {
  const index = await readCodexSessionIndexFile(join(codexHome, "session_index.jsonl"))
  for (const row of await readCodexStateThreadsFromHome(codexHome, localImportMaxFiles())) {
    await withThreadHistoryLock(row.id, () =>
      syncThreadToCanonicalFromSource(codexHome, row, index),
    )
  }

  const files = (await listSessionFiles(join(codexHome, "sessions")))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, localImportMaxFiles())
  for (const file of files) {
    const threadId = extractSessionIdFromPath(file.path)
    if (!threadId) {
      continue
    }
    const parsed = await readLocalCodexSessionTranscriptFile(file.path, threadId)
    if (!parsed) {
      continue
    }
    await withThreadHistoryLock(threadId, () =>
      syncThreadToCanonicalFromSource(
        codexHome,
        stateRowFromParsedSession(parsed, file.path),
        index,
        parsed,
      ),
    )
  }
}

async function syncThreadFromCodexHome(
  threadId: string,
  codexHome: string,
): Promise<boolean> {
  const index = await readCodexSessionIndexFile(join(codexHome, "session_index.jsonl"))
  const row = await readCodexStateThreadFromHome(codexHome, threadId)
  if (row) {
    return syncThreadToCanonicalFromSource(codexHome, row, index)
  }

  const sessionPath = await findCodexHomeSessionPath(codexHome, threadId)
  if (!sessionPath) {
    return false
  }
  const parsed = await readLocalCodexSessionTranscriptFile(sessionPath, threadId)
  if (!parsed) {
    return false
  }
  return syncThreadToCanonicalFromSource(
    codexHome,
    stateRowFromParsedSession(parsed, sessionPath),
    index,
    parsed,
  )
}

async function syncThreadToCanonicalFromSource(
  codexHome: string,
  row: CodexStateThreadRow,
  index: Map<string, LocalCodexSessionIndexMetadata>,
  parsed?: ParsedLocalCodexSession | null,
): Promise<boolean> {
  const sessionPath =
    (await firstAccessiblePath(codexHomeSessionPathCandidates(codexHome, row.rolloutPath))) ??
    (await findCodexHomeSessionPath(codexHome, row.id))
  if (!sessionPath) {
    return false
  }
  const resolvedParsed =
    parsed ?? (await readLocalCodexSessionTranscriptFile(sessionPath, row.id))
  const info = await stat(sessionPath).catch(() => null)
  const primaryMetadata = index.get(row.id) ?? null
  const secondaryMetadata = await readLocalSessionIndexMetadata(sessionPath, row.id)
  const sourceUpdatedAt = latestDate([
    codexStateUpdatedAt(row),
    resolvedParsed?.updatedAt,
    info ? new Date(info.mtimeMs) : null,
    primaryMetadata?.updatedAt,
    secondaryMetadata?.updatedAt,
  ])
  const relativePath = sessionRelativePath(sessionPath)
  const destination = canonicalSessionPath(relativePath)
  const metadata = mergeSessionIndexMetadata(
    primaryMetadata,
    secondaryMetadata,
    row,
    resolvedParsed,
    sourceUpdatedAt,
  )
  const state = normalizeCodexStateThreadRow({
    ...row,
    rolloutPath: destination,
    updatedAt: timestampSeconds(sourceUpdatedAt),
    updatedAtMs: sourceUpdatedAt.getTime(),
  })
  const existing = await readCanonicalThreadRecord(row.id)
  if (existing) {
    const existingUpdatedAt = codexStateUpdatedAt(existing.state).getTime()
    const sourceTime = sourceUpdatedAt.getTime()
    if (existingUpdatedAt > sourceTime) {
      return false
    }
    const destinationInfo = await stat(destination).catch(() => null)
    if (
      existingUpdatedAt === sourceTime &&
      destinationInfo &&
      info &&
      destinationInfo.size === info.size &&
      existing.sessionRelativePath === relativePath &&
      sameSessionIndexMetadata(existing.index, metadata) &&
      sameCodexStateThread(existing.state, state)
    ) {
      return false
    }
  }

  await copyFileAtomic(sessionPath, destination)
  const record: CanonicalThreadRecord = {
    index: metadata,
    sessionRelativePath: relativePath,
    state,
    syncedAt: new Date().toISOString(),
  }
  await writeCanonicalThreadRecord(record)
  await upsertSessionIndexRecord(canonicalSessionIndexPath(), row.id, metadata)
  await exportCanonicalThreadToSharedCodex(record).catch((error) => {
    console.warn(
      "Failed to export history to external Codex home.",
      error instanceof Error ? error.message : error,
    )
  })
  return true
}

async function hydrateCanonicalThreadToAccount(
  threadId: string,
  accountId: string,
): Promise<boolean> {
  const record = await readCanonicalThreadRecord(threadId)
  if (!record) {
    return false
  }
  const accountHome = ensureAccountCodexHome(accountId)
  const source = canonicalSessionPath(record.sessionRelativePath)
  const destination = join(accountHome, "sessions", record.sessionRelativePath)
  await copyFileAtomic(source, destination)
  await upsertSessionIndexRecord(
    join(accountHome, "session_index.jsonl"),
    threadId,
    record.index,
  )
  await upsertAccountCodexStateThread(accountId, record, destination)
  return true
}

async function upsertAccountCodexStateThread(
  accountId: string,
  record: CanonicalThreadRecord,
  rolloutPath: string,
): Promise<void> {
  const databasePath = resolveAccountCodexStateDatabasePath(accountId)
  await upsertCodexStateThreadAtDatabase(
    databasePath,
    record,
    rolloutPath,
    `account ${accountId}`,
  )
}

async function exportCanonicalThreadToSharedCodex(
  record: CanonicalThreadRecord,
): Promise<void> {
  const sharedHome = resolveCodexSharedChatHome()
  const source = canonicalSessionPath(record.sessionRelativePath)
  const destination = join(sharedHome, "sessions", record.sessionRelativePath)
  await copyFileAtomic(source, destination)
  await upsertSessionIndexRecord(
    join(sharedHome, "session_index.jsonl"),
    record.state.id,
    record.index,
  )
  await upsertCodexStateThreadAtDatabase(
    await codexStateDatabasePathForHome(sharedHome),
    record,
    destination,
    "external Codex home",
  )
}

async function upsertCodexStateThreadAtDatabase(
  databasePath: string,
  record: CanonicalThreadRecord,
  rolloutPath: string,
  label: string,
): Promise<void> {
  await ensureCodexStateDatabaseSchema(databasePath)
  const client = await codexStateClient(databasePath)
  if (!client) {
    throw new Error(`Codex state database is not readable for ${label}.`)
  }
  const columns = await readCodexStateThreadColumns(client)
  await upsertCodexStateThreadRow(
    client,
    columns,
    normalizeCodexStateThreadRow({
      ...record.state,
      rolloutPath,
    }),
  )
}

async function upsertCodexStateThreadRow(
  client: PrismaClient,
  columns: Set<string>,
  row: CodexStateThreadRow,
): Promise<void> {
  const values = codexStateThreadValueMap(row)
  const names = Object.keys(values).filter((name) => columns.has(name))
  if (!names.includes("id") || !names.includes("rollout_path")) {
    throw new Error("Codex state database is missing required thread columns.")
  }
  const placeholders = names.map(() => "?").join(", ")
  const updateSql = names
    .filter((name) => name !== "id")
    .map((name) => `"${name}" = excluded."${name}"`)
    .join(", ")
  await client.$executeRawUnsafe(
    `
      INSERT INTO threads (${names.map((name) => `"${name}"`).join(", ")})
      VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updateSql}
    `,
    ...names.map((name) => values[name]),
  )
}

function codexStateThreadValueMap(
  row: CodexStateThreadRow,
): Record<string, string | number | null> {
  const updatedAt = codexStateUpdatedAt(row)
  const createdAt = codexStateCreatedAt(row, updatedAt)
  return {
    agent_nickname: row.agentNickname,
    agent_path: row.agentPath,
    agent_role: row.agentRole,
    approval_mode: row.approvalMode ?? "",
    archived: row.archived ?? 0,
    archived_at: row.archivedAt
      ? timestampSeconds(dateFromCodexTimestamp(row.archivedAt, new Date(0)))
      : null,
    cli_version: row.cliVersion ?? "",
    created_at: timestampSeconds(createdAt),
    created_at_ms: createdAt.getTime(),
    cwd: row.cwd ?? "",
    first_user_message: row.firstUserMessage ?? "",
    git_branch: row.gitBranch,
    git_origin_url: row.gitOriginUrl,
    git_sha: row.gitSha,
    has_user_event: row.hasUserEvent ?? (row.firstUserMessage ? 1 : 0),
    id: row.id,
    memory_mode: row.memoryMode ?? "enabled",
    model: row.model,
    model_provider: row.modelProvider ?? "",
    preview: row.preview ?? "",
    reasoning_effort: row.reasoningEffort,
    rollout_path: row.rolloutPath ?? "",
    sandbox_policy: row.sandboxPolicy ?? "",
    source: row.source ?? "xedoc",
    thread_source: row.threadSource ?? "xedoc",
    title: row.title ?? "",
    tokens_used: row.tokensUsed ?? 0,
    updated_at: timestampSeconds(updatedAt),
    updated_at_ms: updatedAt.getTime(),
  }
}

async function ensureCodexStateDatabaseSchema(databasePath: string): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 })
  const client = await openCodexStateClient(databasePath)
  for (const statement of CODEX_STATE_SCHEMA_SQL) {
    await client.$executeRawUnsafe(statement)
  }
}

const CODEX_STATE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    git_sha TEXT,
    git_branch TEXT,
    git_origin_url TEXT,
    cli_version TEXT NOT NULL DEFAULT '',
    first_user_message TEXT NOT NULL DEFAULT '',
    agent_nickname TEXT,
    agent_role TEXT,
    memory_mode TEXT NOT NULL DEFAULT 'enabled',
    model TEXT,
    reasoning_effort TEXT,
    agent_path TEXT,
    created_at_ms INTEGER,
    updated_at_ms INTEGER,
    thread_source TEXT,
    preview TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_threads_created_at ON threads(created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_threads_archived ON threads(archived)",
  "CREATE INDEX IF NOT EXISTS idx_threads_created_at_ms ON threads(created_at_ms DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_threads_updated_at_ms ON threads(updated_at_ms DESC, id DESC)",
]

async function existingAccountCodexHistoryHomes(): Promise<string[]> {
  const homes = await accountCodexHomes()
  const existing: string[] = []
  const seen = new Set<string>()
  for (const home of homes.map((entry) => resolveHomePath(entry))) {
    try {
      await access(home, constants.R_OK)
      const key = await realpath(home).catch(() => home)
      if (!seen.has(key)) {
        seen.add(key)
        existing.push(home)
      }
    } catch {
      // Missing Codex homes are expected for new installs.
    }
  }
  return existing
}

async function accountCodexHomes(): Promise<string[]> {
  try {
    const accountsHome = resolveCodexAccountsHome()
    const entries = await readdir(accountsHome, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(accountsHome, entry.name))
  } catch {
    return []
  }
}

async function ensureCanonicalHistoryHome(): Promise<void> {
  await mkdir(canonicalSessionsHome(), { recursive: true, mode: 0o700 })
  await mkdir(canonicalThreadsHome(), { recursive: true, mode: 0o700 })
  await upsertSessionIndexRecord(canonicalSessionIndexPath(), "", null)
}

function canonicalSessionsHome(): string {
  return join(resolveCodexHistoryHome(), "sessions")
}

function canonicalThreadsHome(): string {
  return join(resolveCodexHistoryHome(), "threads")
}

function canonicalSessionIndexPath(): string {
  return join(resolveCodexHistoryHome(), "session_index.jsonl")
}

function canonicalSessionPath(relativePath: string): string {
  return join(canonicalSessionsHome(), relativePath)
}

function canonicalThreadRecordPath(threadId: string): string {
  return join(canonicalThreadsHome(), `${encodeURIComponent(threadId)}.json`)
}

async function readCanonicalThreadRecord(
  threadId: string,
): Promise<CanonicalThreadRecord | null> {
  try {
    const parsed = asJsonObject(
      JSON.parse(await readFile(canonicalThreadRecordPath(threadId), "utf8")),
    )
    if (!parsed) {
      return null
    }
    const state = readCanonicalCodexStateThreadRow(parsed.state)
    if (!state || state.id !== threadId) {
      return null
    }
    return {
      index: readCanonicalIndexMetadata(parsed.index),
      sessionRelativePath:
        readString(parsed.sessionRelativePath) ?? sessionRelativePath(state.rolloutPath ?? ""),
      state,
      syncedAt: readString(parsed.syncedAt) ?? new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

async function readCanonicalThreadRecords(): Promise<CanonicalThreadRecord[]> {
  try {
    const entries = await readdir(canonicalThreadsHome(), { withFileTypes: true })
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          readCanonicalThreadRecord(decodeURIComponent(entry.name.slice(0, -5))),
        ),
    )
    return records.filter(
      (record): record is CanonicalThreadRecord => record !== null,
    )
  } catch {
    return []
  }
}

async function writeCanonicalThreadRecord(
  record: CanonicalThreadRecord,
): Promise<void> {
  await writeFileAtomic(
    canonicalThreadRecordPath(record.state.id),
    `${JSON.stringify(record, jsonStringifyReplacer)}\n`,
  )
}

function readCanonicalCodexStateThreadRow(
  value: unknown,
): CodexStateThreadRow | null {
  const object = asJsonObject(value)
  const id = readString(object?.id)
  if (!object || !id) {
    return null
  }
  return normalizeCodexStateThreadRow({
    agentNickname: readString(object.agentNickname),
    agentPath: readString(object.agentPath),
    agentRole: readString(object.agentRole),
    approvalMode: readString(object.approvalMode),
    archived: readNumber(object.archived),
    archivedAt: readNumber(object.archivedAt) ?? readString(object.archivedAt),
    cliVersion: readString(object.cliVersion),
    createdAt: readNumber(object.createdAt) ?? readString(object.createdAt),
    createdAtMs: readNumber(object.createdAtMs) ?? readString(object.createdAtMs),
    cwd: readString(object.cwd),
    firstUserMessage: readString(object.firstUserMessage),
    gitBranch: readString(object.gitBranch),
    gitOriginUrl: readString(object.gitOriginUrl),
    gitSha: readString(object.gitSha),
    hasUserEvent: readNumber(object.hasUserEvent),
    id,
    memoryMode: readString(object.memoryMode),
    model: readString(object.model),
    modelProvider: readString(object.modelProvider),
    preview: readString(object.preview),
    reasoningEffort: readString(object.reasoningEffort),
    rolloutPath: readString(object.rolloutPath),
    sandboxPolicy: readString(object.sandboxPolicy),
    source: readString(object.source),
    threadSource: readString(object.threadSource),
    title: readString(object.title),
    tokensUsed: readNumber(object.tokensUsed),
    updatedAt: readNumber(object.updatedAt) ?? readString(object.updatedAt),
    updatedAtMs: readNumber(object.updatedAtMs) ?? readString(object.updatedAtMs),
  })
}

function readCanonicalIndexMetadata(
  value: unknown,
): LocalCodexSessionIndexMetadata | null {
  const object = asJsonObject(value)
  if (!object) {
    return null
  }
  return {
    title: normalizeImportedTitle(readString(object.title)),
    updatedAt: readDate(object.updatedAt) ?? null,
  }
}

async function upsertSessionIndexRecord(
  indexPath: string,
  threadId: string,
  metadata: LocalCodexSessionIndexMetadata | null,
): Promise<void> {
  await mkdir(dirname(indexPath), { recursive: true, mode: 0o700 })
  if (!threadId) {
    await readFile(indexPath, "utf8").catch(async () => {
      await writeFile(indexPath, "", { mode: 0o600 })
    })
    return
  }
  const existing = await readFile(indexPath, "utf8").catch(() => "")
  const lines = existing
    .split(/\r?\n/)
    .filter((line) => line.trim() && sessionIndexLineId(line) !== threadId)
  lines.push(
    JSON.stringify({
      id: threadId,
      threadId,
      thread_id: threadId,
      ...(metadata?.title ? { thread_name: metadata.title, title: metadata.title } : {}),
      ...(metadata?.updatedAt
        ? { updatedAt: metadata.updatedAt.toISOString(), updated_at: metadata.updatedAt.toISOString() }
        : {}),
    }),
  )
  await writeFileAtomic(indexPath, `${lines.join("\n")}\n`)
}

function sessionIndexLineId(line: string): string | null {
  const record = parseJsonObject(line)
  return record
    ? readString(record.id) ??
        readString(record.thread_id) ??
        readString(record.threadId) ??
        readString(record.session_id) ??
        readString(record.sessionId) ??
        null
    : null
}

async function copyFileAtomic(source: string, destination: string): Promise<void> {
  if (resolve(source) === resolve(destination) || (await sameRealPath(source, destination))) {
    return
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`
  await copyFile(source, temporary)
  await rename(temporary, destination)
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, path)
}

async function findCodexHomeSessionPath(
  codexHome: string,
  threadId: string,
): Promise<string | null> {
  const files = (await listSessionFiles(join(codexHome, "sessions")))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, localImportMaxFiles())
  return files.find((file) => extractSessionIdFromPath(file.path) === threadId)?.path ?? null
}

function codexHomeSessionPathCandidates(
  codexHome: string,
  rolloutPath: string | null | undefined,
): string[] {
  const trimmed = rolloutPath?.trim()
  if (!trimmed) {
    return []
  }
  return [
    ...new Set([
      trimmed,
      join(codexHome, "sessions", sessionRelativePath(trimmed)),
      canonicalSessionPath(sessionRelativePath(trimmed)),
    ]),
  ]
}

async function firstAccessiblePath(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path, constants.R_OK)
      return path
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function mergeSessionIndexMetadata(
  primary: LocalCodexSessionIndexMetadata | null,
  secondary: LocalCodexSessionIndexMetadata | null,
  row: CodexStateThreadRow,
  parsed: ParsedLocalCodexSession | null | undefined,
  fallbackUpdatedAt: Date,
): LocalCodexSessionIndexMetadata {
  return {
    title:
      normalizeImportedTitle(primary?.title) ??
      normalizeImportedTitle(secondary?.title) ??
      normalizeImportedTitle(row.title) ??
      normalizeImportedTitle(parsed?.title) ??
      null,
    updatedAt:
      primary?.updatedAt ??
      secondary?.updatedAt ??
      latestDate([codexStateUpdatedAt(row), parsed?.updatedAt, fallbackUpdatedAt]),
  }
}

function sameSessionIndexMetadata(
  left: LocalCodexSessionIndexMetadata | null,
  right: LocalCodexSessionIndexMetadata | null,
): boolean {
  return (
    (left?.title ?? null) === (right?.title ?? null) &&
    (left?.updatedAt?.getTime() ?? null) === (right?.updatedAt?.getTime() ?? null)
  )
}

function sameCodexStateThread(
  left: CodexStateThreadRow,
  right: CodexStateThreadRow,
): boolean {
  return (
    JSON.stringify(codexStateThreadValueMap(left)) ===
    JSON.stringify(codexStateThreadValueMap(right))
  )
}

function stateRowFromParsedSession(
  session: ParsedLocalCodexSession,
  path: string,
): CodexStateThreadRow {
  return normalizeCodexStateThreadRow({
    archived: 0,
    createdAt: timestampSeconds(session.createdAt),
    createdAtMs: session.createdAt.getTime(),
    cwd: session.workingDirectory ?? "",
    firstUserMessage:
      session.messages.find((message) => message.role === "USER")?.content ?? "",
    hasUserEvent: session.messages.some((message) => message.role === "USER") ? 1 : 0,
    id: session.externalThreadId,
    rolloutPath: path,
    source: session.source ?? "xedoc",
    title: session.title,
    updatedAt: timestampSeconds(session.updatedAt),
    updatedAtMs: session.updatedAt.getTime(),
  })
}

function normalizeCodexStateThreadRow(
  row: Partial<CodexStateThreadRow> & { id: string },
): CodexStateThreadRow {
  return {
    agentNickname: row.agentNickname ?? null,
    agentPath: row.agentPath ?? null,
    agentRole: row.agentRole ?? null,
    approvalMode: row.approvalMode ?? null,
    archived: row.archived ?? null,
    archivedAt: row.archivedAt ?? null,
    cliVersion: row.cliVersion ?? null,
    createdAt: row.createdAt ?? null,
    createdAtMs: row.createdAtMs ?? null,
    cwd: row.cwd ?? null,
    firstUserMessage: row.firstUserMessage ?? null,
    gitBranch: row.gitBranch ?? null,
    gitOriginUrl: row.gitOriginUrl ?? null,
    gitSha: row.gitSha ?? null,
    hasUserEvent: row.hasUserEvent ?? null,
    id: row.id,
    memoryMode: row.memoryMode ?? null,
    model: row.model ?? null,
    modelProvider: row.modelProvider ?? null,
    preview: row.preview ?? null,
    reasoningEffort: row.reasoningEffort ?? null,
    rolloutPath: row.rolloutPath ?? null,
    sandboxPolicy: row.sandboxPolicy ?? null,
    source: row.source ?? null,
    threadSource: row.threadSource ?? null,
    title: row.title ?? null,
    tokensUsed: row.tokensUsed ?? null,
    updatedAt: row.updatedAt ?? null,
    updatedAtMs: row.updatedAtMs ?? null,
  }
}

function codexStateUpdatedAt(row: CodexStateThreadRow): Date {
  return dateFromCodexTimestamp(row.updatedAtMs ?? row.updatedAt, new Date(0))
}

function codexStateCreatedAt(row: CodexStateThreadRow, fallback: Date): Date {
  return dateFromCodexTimestamp(row.createdAtMs ?? row.createdAt, fallback)
}

function latestDate(values: Array<Date | null | undefined>): Date {
  let latest = new Date(0)
  for (const value of values) {
    if (!value || Number.isNaN(value.getTime())) {
      continue
    }
    if (value.getTime() > latest.getTime()) {
      latest = value
    }
  }
  return latest
}

function withThreadHistoryLock<T>(
  threadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = threadHistoryLocks.get(threadId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = previous.catch(() => undefined).then(() => current)
  threadHistoryLocks.set(threadId, next)
  return previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      release()
      if (threadHistoryLocks.get(threadId) === next) {
        threadHistoryLocks.delete(threadId)
      }
    })
}

function timestampSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000)
}

function jsonStringifyReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value
}

export async function readLocalCodexSessionTranscriptForChat(
  chatId: string,
  threadId: string,
  options: LocalHistoryReadOptions = {},
): Promise<ParsedLocalCodexSession | null> {
  void chatId
  const sessionPath = await findLocalCodexSessionPath(threadId, options)
  return sessionPath
    ? readLocalCodexSessionTranscriptFile(sessionPath, threadId)
    : null
}

export async function readLatestLocalCodexContextUsageForChat(
  chatId: string,
  threadId: string,
  options: LocalHistoryReadOptions = {},
): Promise<ContextWindowUsagePayload | null> {
  void chatId
  const sessionPath = await findLocalCodexSessionPath(threadId, options)
  return sessionPath
    ? readLatestLocalCodexContextUsageFile(sessionPath, threadId)
    : null
}

export async function readLocalCodexSessionTranscript(
  threadId: string,
  options: LocalHistoryReadOptions = {},
): Promise<ParsedLocalCodexSession | null> {
  const sessionPath = await findLocalCodexSessionPath(threadId, options)
  return sessionPath
    ? readLocalCodexSessionTranscriptFile(sessionPath, threadId)
    : null
}

export async function readLocalCodexSessionActivity(
  threadId: string,
  options: LocalHistoryReadOptions = {},
): Promise<Pick<
  ParsedLocalCodexSession,
  "activeStartedAt" | "activeTurnId" | "status"
> | null> {
  const session = await readLocalCodexSessionTranscript(threadId, options)
  return session
    ? {
        activeStartedAt: session.activeStartedAt,
        activeTurnId: session.activeTurnId,
        status: localSessionActivityStatus(session),
      }
    : null
}

export async function readLatestLocalCodexContextUsage(
  threadId: string,
  options: LocalHistoryReadOptions = {},
): Promise<ContextWindowUsagePayload | null> {
  const sessionPath = await findLocalCodexSessionPath(threadId, options)
  return sessionPath
    ? readLatestLocalCodexContextUsageFile(sessionPath, threadId)
    : null
}

export async function readLocalCodexSessionMetadata(
  threadId: string,
  options: LocalHistoryReadOptions = {},
): Promise<LocalCodexSessionSummary | null> {
  await ensureCanonicalHistoryForRead(options)
  const record = await readCanonicalThreadRecord(threadId)
  if (!record) {
    return null
  }
  return summaryFromCodexStateThread(record.state, record.index?.title ?? null)
}

export async function listLocalCodexSessionSummaries(
  options: LocalHistoryReadOptions = {},
): Promise<LocalCodexSessionSummary[]> {
  await ensureCanonicalHistoryForRead(options)
  return (await readCanonicalThreadRecords())
    .map((record) =>
      summaryFromCodexStateThread(
        record.state,
        record.index?.title ?? null,
      ),
    )
    .sort(
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
  let activeStartedAt: Date | undefined
  let activeTurnId: string | undefined
  let currentTurnId: string | undefined
  let lineIndex = 0
  let turnIndex = 0
  const functionCallOutputs = new Map<string, LocalFunctionCallOutput>()
  const responseMessages: OrderedImportedLocalMessage[] = []
  const eventMessages: OrderedImportedLocalMessage[] = []
  const suppressedToolOutputCallIds = new Set<string>()

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    lineIndex += 1
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

    const payloadType = readString(payload?.type)
    if (record.type === "event_msg" && payloadType === "task_started") {
      turnIndex += 1
      currentTurnId =
        readTurnIdFromPayload(payload) ?? localTurnId(sessionId, path, turnIndex)
      activeTurnId = currentTurnId
      activeStartedAt =
        readDate(payload?.started_at) ??
        readDate(payload?.startedAt) ??
        timestamp
    }
    if (record.type === "response_item" && payloadType === "function_call_output") {
      const callId = readCallId(payload ?? {})
      if (callId) {
        functionCallOutputs.set(callId, {
          output: outputPayloadText(payload?.output),
          timestamp,
        })
      }
    }

    if (record.type === "turn_context" && payload) {
      workingDirectory = readString(payload.cwd) ?? workingDirectory
      continue
    }

    const context: LocalSessionMessageContext = {
      originator,
      path,
      sessionId,
      source,
      suppressedToolOutputCallIds,
      turnId: readTurnIdFromPayload(payload) ?? currentTurnId,
    }

    const responseMessage = importedResponseMessage(record, timestamp, context)
    if (responseMessage) {
      responseMessages.push({ ...responseMessage, order: lineIndex })
      continue
    }

    if (record.type === "event_msg" && payloadType === "task_complete") {
      const completedTurnId = readTurnIdFromPayload(payload)
      if (!completedTurnId || completedTurnId === activeTurnId) {
        activeStartedAt = undefined
        activeTurnId = undefined
      }
      currentTurnId = undefined
    }

    const eventMessage = importedEventMessage(record, timestamp, context)
    if (eventMessage) {
      eventMessages.push({ ...eventMessage, order: lineIndex })
    }
  }

  const messages = reconcileImportedMessages(
    resolveImportedUserInputMessages(responseMessages, functionCallOutputs),
    eventMessages,
  )
  const externalThreadId = sessionId ?? extractSessionIdFromPath(path)
  if (!externalThreadId || (!messages.length && !activeTurnId)) {
    return null
  }

  const firstUserMessage = messages.find((message) => message.role === "USER")
  const title =
    fallbackChatTitle(firstUserMessage?.content ?? "") ??
    fallbackChatTitle(messages[0]?.content ?? "") ??
    "Imported Codex chat"

  return {
    activeStartedAt,
    activeTurnId,
    createdAt: createdAt ?? fallbackTimestamp,
    externalThreadId,
    messages,
    originator,
    path,
    source,
    status: activeTurnId && !activeSessionLooksStale(updatedAt ?? fallbackTimestamp)
      ? "RUNNING"
      : "IDLE",
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
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
  if (record.type !== "response_item") {
    return null
  }
  const payload = asJsonObject(record.payload)
  const payloadType = readString(payload?.type)
  if (!payload || !payloadType) {
    return null
  }

  if (payloadType === "message") {
    return importedResponseChatMessage(record, payload, timestamp, session)
  }
  if (payloadType === "reasoning") {
    return importedReasoningResponseMessage(record, payload, timestamp, session)
  }
  if (isToolCallResponseItem(payloadType)) {
    return importedToolCallResponseMessage(record, payload, timestamp, session)
  }
  if (isToolOutputResponseItem(payloadType)) {
    return importedToolOutputResponseMessage(record, payload, timestamp, session)
  }
  if (payloadType === "compaction" || payloadType === "context_compaction") {
    return importedSystemActivityMessage(
      record,
      payload,
      timestamp,
      session,
      compactionMessage(payloadType),
      "contextCompaction",
    )
  }

  return null
}

function importedResponseChatMessage(
  record: JsonObject,
  payload: JsonObject,
  timestamp: Date,
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
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
    itemId: responseItemId(payload),
    metadata: importedMessageMetadata(payload, session),
    rawPayload: compactRawPayload(record, payload),
    role,
    turnId: session.turnId,
  }
}

function importedReasoningResponseMessage(
  record: JsonObject,
  payload: JsonObject,
  timestamp: Date,
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
  const content = reasoningResponseText(payload)
  if (!content.trim()) {
    return null
  }
  return {
    content,
    createdAt: timestamp,
    itemId: responseItemId(payload),
    kind: "THINKING",
    metadata: {
      ...importedMessageMetadata(payload, session),
      responseItemType: readString(payload.type),
    },
    rawPayload: compactRawPayload(record, payload),
    role: "SYSTEM",
    turnId: session.turnId,
  }
}

function importedToolCallResponseMessage(
  record: JsonObject,
  payload: JsonObject,
  timestamp: Date,
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
  const payloadType = readString(payload.type) ?? "tool_call"
  const toolName = readString(payload.name) ?? payloadType.replaceAll("_", " ")
  if (payloadType === "function_call" && toolName === "update_plan") {
    return importedUpdatePlanMessage(record, payload, timestamp, session)
  }
  if (payloadType === "function_call" && toolName === "request_user_input") {
    return importedUserInputRequestMessage(record, payload, timestamp, session)
  }
  if (payloadType === "web_search_call") {
    return importedSystemActivityMessage(
      record,
      payload,
      timestamp,
      session,
      webSearchLabel(payload),
      "webSearch",
    )
  }
  if (payloadType === "image_generation_call") {
    return importedSystemActivityMessage(
      record,
      payload,
      timestamp,
      session,
      "Image generation",
      "imageGeneration",
    )
  }

  const argumentsObject = readArgumentsObject(payload.arguments)
  const command = commandLabelFromToolCall(payload, argumentsObject)
  const isCommand = commandLikeToolCall(payloadType, toolName)
  if (isCommand) {
    return {
      content: command ?? toolName,
      createdAt: timestamp,
      itemId: responseItemId(payload),
      kind: "COMMAND_EXECUTION",
      metadata: {
        ...importedMessageMetadata(payload, session),
        callId: readCallId(payload),
        command: command ?? toolName,
        cwd:
          readString(argumentsObject?.cwd) ??
          readString(argumentsObject?.workdir) ??
          readString(asJsonObject(payload.action)?.cwd),
        kind: "command",
        status: readString(payload.status) ?? "completed",
      },
      rawPayload: compactRawPayload(record, payload),
      role: "SYSTEM",
      turnId: session.turnId,
    }
  }

  return importedSystemActivityMessage(
    record,
    payload,
    timestamp,
    session,
    toolName,
    "toolCall",
  )
}

function importedToolOutputResponseMessage(
  record: JsonObject,
  payload: JsonObject,
  timestamp: Date,
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
  const callId = readCallId(payload)
  if (callId && session.suppressedToolOutputCallIds?.has(callId)) {
    return null
  }
  const output = outputPayloadText(payload.output)
  if (!output.trim()) {
    return null
  }
  return {
    content: output,
    createdAt: timestamp,
    itemId: responseItemOutputId(payload),
    kind: "TOOL_ACTIVITY",
    metadata: {
      ...importedMessageMetadata(payload, session),
      callId: readCallId(payload),
      kind: "localCodexToolOutput",
      responseItemType: readString(payload.type),
      status: readString(payload.status) ?? "completed",
      toolName: readString(payload.name),
    },
    rawPayload: compactRawPayload(record, payload),
    role: "SYSTEM",
    turnId: session.turnId,
  }
}

function importedUpdatePlanMessage(
  record: JsonObject,
  payload: JsonObject,
  timestamp: Date,
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
  const callId = readCallId(payload)
  if (callId) {
    session.suppressedToolOutputCallIds?.add(callId)
  }
  const argumentsObject = readArgumentsObject(payload.arguments) ?? {}
  const plan = Array.isArray(argumentsObject.plan) ? argumentsObject.plan : []
  const steps = plan
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => !!entry)
    .map((entry) => ({
      status: readString(entry.status) ?? "pending",
      step: readString(entry.step) ?? "",
    }))
    .filter((entry) => entry.step)
  const explanation = readString(argumentsObject.explanation)
  const content = explanation ?? steps.map((step) => step.step).join("\n")
  if (!content.trim() && !steps.length) {
    return null
  }
  return {
    completedAt: timestamp,
    content,
    createdAt: timestamp,
    itemId: responseItemId(payload) ?? `plan:${session.turnId ?? timestamp.getTime()}`,
    kind: "PLAN",
    metadata: {
      ...importedMessageMetadata(payload, session),
      explanation,
      kind: "plan",
      presentation: "progress",
      responseItemType: readString(payload.type),
      status: readString(payload.status) ?? "completed",
      steps,
      toolName: "update_plan",
    },
    rawPayload: compactRawPayload(record, payload),
    role: "SYSTEM",
    status: "COMPLETED",
    turnId: session.turnId,
  }
}

function importedUserInputRequestMessage(
  record: JsonObject,
  payload: JsonObject,
  timestamp: Date,
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
  const requestId = readCallId(payload)
  if (!requestId) {
    return null
  }
  session.suppressedToolOutputCallIds?.add(requestId)
  const argumentsObject = readArgumentsObject(payload.arguments) ?? {}
  const message =
    readString(argumentsObject.message) ??
    "Codex needs more information before it can continue."
  return {
    completedAt: null,
    content: message,
    createdAt: timestamp,
    itemId: responseItemId(payload),
    kind: "USER_INPUT_PROMPT",
    metadata: {
      ...importedMessageMetadata(payload, session),
      kind: "userInput",
      message,
      method: "request_user_input",
      mode: readString(argumentsObject.mode),
      questions: decodeImportedUserInputQuestions(argumentsObject.questions),
      requestId,
      status: "pending",
      toolName: "request_user_input",
    },
    rawPayload: compactRawPayload(record, payload),
    requestId,
    role: "SYSTEM",
    status: "PENDING",
    turnId: session.turnId,
  }
}

function importedSystemActivityMessage(
  record: JsonObject,
  payload: JsonObject,
  timestamp: Date,
  session: LocalSessionMessageContext,
  content: string,
  eventKind: string,
): ImportedLocalMessage | null {
  if (!content.trim()) {
    return null
  }
  return {
    content,
    createdAt: timestamp,
    itemId: responseItemId(payload),
    kind: "TOOL_ACTIVITY",
    metadata: {
      ...importedMessageMetadata(payload, session),
      eventKind,
      responseItemType: readString(payload.type),
      status: readString(payload.status),
    },
    rawPayload: compactRawPayload(record, payload),
    role: "SYSTEM",
    turnId: session.turnId,
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
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
  if (record.type !== "event_msg") {
    return null
  }
  const payload = asJsonObject(record.payload)
  if (!payload) {
    return null
  }
  const payloadType = readString(payload.type)
  if (payloadType === "patch_apply_end") {
    return importedPatchApplyEventMessage(record, payload, timestamp, session)
  }
  if (payloadType === "web_search_end") {
    return importedSystemActivityMessage(
      record,
      payload,
      timestamp,
      session,
      webSearchLabel(payload),
      "webSearch",
    )
  }
  if (payloadType === "task_complete") {
    const content = readString(payload.last_agent_message) ?? ""
    if (!content.trim() || isInternalEnvironmentContext(content)) {
      return null
    }
    return {
      content,
      createdAt: timestamp,
      itemId: responseItemId(payload) ?? `task-complete:${session.turnId ?? timestamp.getTime()}`,
      metadata: {
        ...importedMessageMetadata(payload, session),
        eventKind: "taskComplete",
      },
      rawPayload: compactRawPayload(record, payload),
      role: "ASSISTANT",
      turnId: session.turnId,
    }
  }

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
    itemId: responseItemId(payload),
    kind: role === "SYSTEM" ? "TOOL_ACTIVITY" : undefined,
    metadata: {
      ...importedMessageMetadata(payload, session),
      ...(role === "SYSTEM" ? { eventKind: "contextCompaction" } : {}),
    },
    rawPayload: compactRawPayload(record, payload),
    role,
    turnId: session.turnId,
  }
}

function importedPatchApplyEventMessage(
  record: JsonObject,
  payload: JsonObject,
  timestamp: Date,
  session: LocalSessionMessageContext,
): ImportedLocalMessage | null {
  const changes = asJsonObject(payload.changes)
  const paths = changes ? Object.keys(changes) : []
  const status =
    readString(payload.status) ??
    (payload.success === false ? "failed" : "completed")
  if (!paths.length) {
    return importedSystemActivityMessage(
      record,
      payload,
      timestamp,
      session,
      readString(payload.stderr) ?? readString(payload.stdout) ?? "Patch applied",
      "patchApply",
    )
  }
  return {
    content: paths.join("\n"),
    createdAt: timestamp,
    itemId: responseItemId(payload) ?? `patch:${session.turnId ?? timestamp.getTime()}`,
    kind: "FILE_CHANGE",
    metadata: {
      ...importedMessageMetadata(payload, session),
      additions: 0,
      deletions: 0,
      kind: "fileChange",
      paths,
      status,
    },
    rawPayload: compactRawPayload(record, payload),
    role: "SYSTEM",
    turnId: session.turnId,
  }
}

function resolveImportedUserInputMessages(
  messages: OrderedImportedLocalMessage[],
  functionCallOutputs: Map<string, LocalFunctionCallOutput>,
): OrderedImportedLocalMessage[] {
  return messages.map((message) => {
    if (
      message.kind !== "USER_INPUT_PROMPT" ||
      !message.requestId ||
      message.status !== "PENDING"
    ) {
      return message
    }
    const output = functionCallOutputs.get(message.requestId)
    if (!output) {
      return message
    }
    return {
      ...message,
      completedAt: output.timestamp,
      metadata: {
        ...message.metadata,
        resolvedAt: output.timestamp.toISOString(),
        result: parseFunctionCallOutputResult(output.output),
        status: "resolved",
      },
      status: "COMPLETED",
    }
  })
}

function parseFunctionCallOutputResult(output: string): unknown {
  const trimmed = output.trim()
  if (!trimmed) {
    return null
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function decodeImportedUserInputQuestions(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((entry) => asJsonObject(entry))
    .filter((entry): entry is JsonObject => !!entry)
    .map((entry, index) => ({
      header: readString(entry.header),
      id: readString(entry.id) ?? `question-${index + 1}`,
      isOther: typeof entry.isOther === "boolean" ? entry.isOther : undefined,
      isSecret: typeof entry.isSecret === "boolean" ? entry.isSecret : undefined,
      options: decodeImportedUserInputOptions(entry.options),
      question: readString(entry.question) ?? readString(entry.header) ?? "Answer",
      selectionLimit:
        readNumber(entry.selectionLimit) ?? readNumber(entry.selection_limit),
    }))
}

function decodeImportedUserInputOptions(value: unknown) {
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
    normalized.startsWith("# agents.md instructions for ") ||
    normalized.startsWith("<environment context>") ||
    normalized.startsWith("environment context") ||
    normalized.startsWith("environmentcontext")
  )
}

function activeSessionLooksStale(updatedAt: Date): boolean {
  return Date.now() - updatedAt.getTime() > STALE_ACTIVE_SESSION_MS
}

function localSessionActivityStatus(
  session: Pick<ParsedLocalCodexSession, "activeTurnId" | "status" | "updatedAt">,
): ParsedLocalCodexSession["status"] {
  if (session.status !== "RUNNING" || !session.activeTurnId) {
    return "IDLE"
  }
  return activeSessionLooksStale(session.updatedAt) ? "IDLE" : "RUNNING"
}

function importedMessageMetadata(
  payload: JsonObject,
  session: LocalSessionMessageContext,
): JsonObject {
  return {
    kind: "localCodexImport",
    originator: session.originator,
    phase: readString(payload.phase),
    sessionId: session.sessionId,
    sessionPath: session.path,
    source: session.source,
    sourcePayloadType: readString(payload.type),
    turnId: session.turnId,
  }
}

function compactRawPayload(record: JsonObject, payload: JsonObject): JsonObject {
  return {
    payload: {
      callId: readCallId(payload),
      id: readString(payload.id),
      name: readString(payload.name),
      phase: readString(payload.phase),
      role: readString(payload.role),
      status: readString(payload.status),
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

function reconcileImportedMessages(
  responseMessages: OrderedImportedLocalMessage[],
  eventMessages: OrderedImportedLocalMessage[],
): ImportedLocalMessage[] {
  if (!responseMessages.length) {
    return eventMessages.sort(compareImportedMessageOrder).map(stripImportOrder)
  }

  const merged = [...responseMessages]
  for (const eventMessage of eventMessages) {
    if (eventMessage.role === "SYSTEM") {
      if (!merged.some((message) => importedSystemEventsOverlap(message, eventMessage))) {
        merged.push(eventMessage)
      }
      continue
    }

    const matchingIndex = merged.findIndex((message) =>
      importedMessagesOverlap(message, eventMessage),
    )
    if (matchingIndex < 0) {
      merged.push(eventMessage)
      continue
    }

    const matchingMessage = merged[matchingIndex]
    if (eventMessage.content.length > matchingMessage.content.length) {
      merged[matchingIndex] = {
        ...matchingMessage,
        content: eventMessage.content,
      }
    }
  }

  return merged.sort(compareImportedMessageOrder).map(stripImportOrder)
}

function importedSystemEventsOverlap(
  left: ImportedLocalMessage,
  right: ImportedLocalMessage,
): boolean {
  const leftEventKind = readString(asJsonObject(left.metadata)?.eventKind)
  const rightEventKind = readString(asJsonObject(right.metadata)?.eventKind)
  return (
    !!leftEventKind &&
    leftEventKind === rightEventKind &&
    importedMessagesOverlap(left, right)
  )
}

function importedMessagesOverlap(
  left: ImportedLocalMessage,
  right: ImportedLocalMessage,
): boolean {
  if (left.role !== right.role) {
    return false
  }
  if ((left.kind ?? "CHAT") !== (right.kind ?? "CHAT")) {
    return false
  }
  if (left.turnId && right.turnId && left.turnId !== right.turnId) {
    return false
  }
  const leftContent = left.content.trim()
  const rightContent = right.content.trim()
  return (
    leftContent === rightContent ||
    leftContent.startsWith(rightContent) ||
    rightContent.startsWith(leftContent)
  )
}

function compareImportedMessageOrder(
  left: OrderedImportedLocalMessage,
  right: OrderedImportedLocalMessage,
): number {
  return left.order - right.order
}

function stripImportOrder({
  order: _order,
  ...message
}: OrderedImportedLocalMessage): ImportedLocalMessage {
  return message
}

function isToolCallResponseItem(payloadType: string): boolean {
  return [
    "custom_tool_call",
    "function_call",
    "image_generation_call",
    "local_shell_call",
    "tool_search_call",
    "web_search_call",
  ].includes(payloadType)
}

function isToolOutputResponseItem(payloadType: string): boolean {
  return [
    "custom_tool_call_output",
    "function_call_output",
    "tool_search_output",
  ].includes(payloadType)
}

function reasoningResponseText(payload: JsonObject): string {
  return [
    contentArrayText(payload.summary),
    contentArrayText(payload.content),
    readString(payload.summary),
    readString(payload.text),
  ]
    .filter((text): text is string => !!text?.trim())
    .join("\n\n")
}

function outputPayloadText(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  return contentArrayText(value) ?? ""
}

function contentArrayText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const text = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry
      }
      const object = asJsonObject(entry)
      return readString(object?.text) ?? imageTagFromObject(object) ?? ""
    })
    .filter(Boolean)
    .join("\n")
  return text || undefined
}

function readArgumentsObject(value: unknown): JsonObject | undefined {
  if (typeof value === "string") {
    try {
      return asJsonObject(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  return asJsonObject(value)
}

function commandLabelFromToolCall(
  payload: JsonObject,
  argumentsObject: JsonObject | undefined,
): string | undefined {
  const action = asJsonObject(payload.action)
  return (
    readString(argumentsObject?.cmd) ??
    readString(argumentsObject?.command) ??
    readString(action?.command) ??
    readString(action?.cmd)
  )
}

function commandLikeToolCall(payloadType: string, toolName: string): boolean {
  return (
    payloadType === "local_shell_call" ||
    ["exec_command", "shell_command", "write_stdin"].includes(toolName)
  )
}

function webSearchLabel(payload: JsonObject): string {
  const action = asJsonObject(payload.action)
  const query =
    readString(payload.query) ??
    readString(action?.query) ??
    readString(action?.pattern) ??
    readString(action?.url)
  return query ? `Web search: ${query}` : "Web search"
}

function responseItemId(payload: JsonObject): string | undefined {
  return readString(payload.id) ?? readCallId(payload)
}

function responseItemOutputId(payload: JsonObject): string | undefined {
  const callId = readCallId(payload)
  return callId ? `${callId}:output` : responseItemId(payload)
}

function readCallId(payload: JsonObject): string | undefined {
  return readString(payload.call_id) ?? readString(payload.callId)
}

function readTurnIdFromPayload(payload: JsonObject | undefined): string | undefined {
  return readString(payload?.turn_id) ?? readString(payload?.turnId)
}

function localTurnId(
  sessionId: string | undefined,
  path: string,
  turnIndex: number,
): string {
  const base = sessionId ?? extractSessionIdFromPath(path) ?? basename(path)
  return `${base}:turn:${turnIndex}`
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

async function readCodexStateThreadsFromHome(
  codexHome: string,
  limit: number,
): Promise<CodexStateThreadRow[]> {
  return readCodexStateThreadsFromDatabasePath(
    await codexStateDatabasePathForHome(codexHome),
    limit,
  )
}

async function readCodexStateThreadsFromDatabasePath(
  databasePath: string,
  limit: number,
): Promise<CodexStateThreadRow[]> {
  const client = await codexStateClient(databasePath)
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

async function readCodexStateThreadFromHome(
  codexHome: string,
  threadId: string,
): Promise<CodexStateThreadRow | null> {
  return readCodexStateThreadFromDatabasePath(
    await codexStateDatabasePathForHome(codexHome),
    threadId,
  )
}

async function readCodexStateThreadFromDatabasePath(
  databasePath: string,
  threadId: string,
): Promise<CodexStateThreadRow | null> {
  const client = await codexStateClient(databasePath)
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
    codexStateColumnSql(columns, "source"),
    codexStateColumnSql(columns, "model_provider", "modelProvider"),
    codexStateDateColumnSql(
      columns,
      columns.has("created_at_ms") ? "created_at_ms" : "created_at",
      "createdAt",
    ),
    codexStateDateColumnSql(columns, "created_at_ms", "createdAtMs"),
    codexStateDateColumnSql(
      columns,
      codexStateThreadUpdatedAtColumn(columns),
      "updatedAt",
    ),
    codexStateDateColumnSql(columns, "updated_at_ms", "updatedAtMs"),
    codexStateColumnSql(columns, "cwd"),
    codexStateColumnSql(columns, "title"),
    codexStateColumnSql(columns, "sandbox_policy", "sandboxPolicy"),
    codexStateColumnSql(columns, "approval_mode", "approvalMode"),
    codexStateColumnSql(columns, "tokens_used", "tokensUsed"),
    codexStateColumnSql(columns, "has_user_event", "hasUserEvent"),
    codexStateColumnSql(columns, "first_user_message", "firstUserMessage"),
    codexStateColumnSql(columns, "preview"),
    codexStateColumnSql(columns, "archived"),
    codexStateColumnSql(columns, "archived_at", "archivedAt"),
    codexStateColumnSql(columns, "git_sha", "gitSha"),
    codexStateColumnSql(columns, "git_branch", "gitBranch"),
    codexStateColumnSql(columns, "git_origin_url", "gitOriginUrl"),
    codexStateColumnSql(columns, "cli_version", "cliVersion"),
    codexStateColumnSql(columns, "agent_nickname", "agentNickname"),
    codexStateColumnSql(columns, "agent_role", "agentRole"),
    codexStateColumnSql(columns, "memory_mode", "memoryMode"),
    codexStateColumnSql(columns, "model"),
    codexStateColumnSql(columns, "reasoning_effort", "reasoningEffort"),
    codexStateColumnSql(columns, "agent_path", "agentPath"),
    codexStateColumnSql(columns, "thread_source", "threadSource"),
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

async function codexStateClient(databasePath: string): Promise<PrismaClient | null> {
  try {
    await access(databasePath, constants.R_OK)
  } catch {
    return null
  }
  return openCodexStateClient(databasePath)
}

async function openCodexStateClient(databasePath: string): Promise<PrismaClient> {
  globalForCodexState.codexStateClients ??= new Map()
  const existing = globalForCodexState.codexStateClients.get(databasePath)
  if (existing) {
    return existing
  }
  const client = new PrismaClient({
    datasources: { db: { url: sqliteDatabaseUrl(databasePath) } },
  })
  globalForCodexState.codexStateClients.set(databasePath, client)
  return client
}

async function codexStateDatabasePathForHome(codexHome: string): Promise<string> {
  const names = await readdir(codexHome).catch(() => [])
  const newest = names
    .filter((name) => /^state_\d+\.sqlite$/i.test(name))
    .sort((left, right) => stateDatabaseVersion(right) - stateDatabaseVersion(left))
    .at(0)
  return join(codexHome, newest ?? "state_5.sqlite")
}

function stateDatabaseVersion(name: string): number {
  return Number(/^state_(\d+)\.sqlite$/i.exec(name)?.[1] ?? 0)
}

function summaryFromCodexStateThread(
  row: CodexStateThreadRow,
  indexedTitle?: string | null,
): LocalCodexSessionSummary {
  const updatedAt = codexStateUpdatedAt(row)
  const createdAt = codexStateCreatedAt(row, updatedAt)
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
    title: codexStateThreadDisplayTitle(row, firstUserMessage, preview, indexedTitle),
    updatedAt,
    workingDirectory: row.cwd ?? undefined,
  }
}

function codexStateThreadDisplayTitle(
  row: CodexStateThreadRow,
  firstUserMessage: string | null,
  preview: string | null,
  indexedTitle?: string | null,
): string | null {
  const stateTitle = normalizeImportedTitle(row.title, { allowGeneric: false })
  const explicitStateTitle =
    stateTitle && !sameImportedTitle(stateTitle, firstUserMessage)
      ? stateTitle
      : null
  return (
    explicitStateTitle ??
    normalizeImportedTitle(indexedTitle, { allowGeneric: false }) ??
    fallbackChatTitle(firstUserMessage ?? "") ??
    fallbackChatTitle(preview ?? "") ??
    null
  )
}

function sameImportedTitle(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false
  }
  return normalizeTitleComparisonValue(left) === normalizeTitleComparisonValue(right)
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
  return trimmed ? [trimmed] : []
}

async function existingSessionRoots(): Promise<string[]> {
  const roots = [
    canonicalSessionsHome(),
    join(resolveCodexSharedChatHome(), "sessions"),
  ]
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

async function findLocalCodexSessionPath(
  threadId: string,
  options: LocalHistoryReadOptions = {},
): Promise<string | null> {
  await ensureCanonicalHistoryForRead(options)
  const record = await readCanonicalThreadRecord(threadId)
  if (!record) {
    return null
  }
  for (const path of rootCodexSessionPathCandidates(record.state.rolloutPath)) {
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
