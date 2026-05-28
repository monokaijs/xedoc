import "dotenv/config"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type {
  CodexEventHandler,
  CodexJsonRpcResponse,
  CodexModelListResponse,
  CodexPendingRequest,
  CodexRateLimitsResponse,
  CodexRuntimeConfig,
  CodexRuntimeSpawnConfig,
  CodexServerRequestHandler,
  JsonObject,
  JsonSerializable,
} from "@/types"
import { prisma } from "./prisma.server"

class CodexRuntime {
  private child?: ChildProcessWithoutNullStreams
  private initializePromise?: Promise<void>
  private stdoutBuffer = ""
  private readonly pending = new Map<string, CodexPendingRequest>()
  private readonly eventHandlers = new Set<CodexEventHandler>()
  private readonly serverRequestHandlers = new Set<CodexServerRequestHandler>()

  constructor(private readonly config: CodexRuntimeConfig) {}

  request(
    method: string,
    params?: JsonObject,
    timeoutMs = 30_000,
  ): Promise<CodexJsonRpcResponse> {
    return this.ensureStarted().then(() =>
      this.requestStarted(method, params, timeoutMs),
    )
  }

  waitForEvent(
    predicate: (message: CodexJsonRpcResponse) => boolean,
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<CodexJsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Stopped waiting for Codex event."))
        return
      }
      const cleanup = () => {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", abort)
        unsubscribe()
      }
      const abort = () => {
        cleanup()
        reject(new Error("Stopped waiting for Codex event."))
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error("Timed out waiting for Codex event."))
      }, timeoutMs)
      const unsubscribe = this.onEvent((message) => {
        if (!predicate(message)) {
          return
        }
        cleanup()
        resolve(message)
      })
      signal?.addEventListener("abort", abort, { once: true })
    })
  }

  sendNotification(method: string, params: JsonObject): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  respondToServerRequest(id: string | number, result: JsonSerializable): void {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`)
  }

  rejectServerRequest(id: string | number, code: number, message: string): void {
    this.child?.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`)
  }

  onEvent(handler: CodexEventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onServerRequest(handler: CodexServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler)
    return () => this.serverRequestHandlers.delete(handler)
  }

  shutdown(): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(new Error("Codex runtime stopped."))
    }
    this.pending.clear()
    this.child?.kill("SIGTERM")
    this.child = undefined
  }

  private requestStarted(
    method: string,
    params?: JsonObject,
    timeoutMs = 30_000,
  ): Promise<CodexJsonRpcResponse> {
    const id = `xedoc-${randomUUID()}`
    const payload = JSON.stringify(
      params === undefined ? { id, method } : { id, method, params },
    )

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.child?.stdin.write(`${payload}\n`)
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise
    }

    const spawnConfig = buildCodexRuntimeSpawnConfig(this.config)
    ensureCodexHome(spawnConfig.codexHome)
    this.child = spawn(spawnConfig.command, spawnConfig.args, spawnConfig.options)

    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk))
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim()
      if (message) {
        console.warn(`[codex:${this.config.accountId}] ${message}`)
        if (isCodexAuthTokenInvalidatedMessage(message)) {
          void markCodexAccountInvalidated(this.config.accountId, message)
        }
      }
    })
    this.child.on("error", (error) => this.failAll(error))
    this.child.on("close", (code) => {
      this.failAll(
        new Error(`Codex runtime exited with code ${code ?? "unknown"}.`),
      )
      this.child = undefined
      this.initializePromise = undefined
    })

    this.initializePromise = this.initialize()
    return this.initializePromise
  }

  private async initialize(): Promise<void> {
    await this.requestStarted("initialize", {
      clientInfo: {
        name: "xedoc",
        title: "xedoc",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    })
    this.child?.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8")
    const lines = this.stdoutBuffer.split("\n")
    this.stdoutBuffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) {
        this.handleLine(trimmed)
      }
    }
  }

  private handleLine(line: string): void {
    let message: CodexJsonRpcResponse
    try {
      message = JSON.parse(line) as CodexJsonRpcResponse
    } catch {
      return
    }

    const classification = classifyCodexMessage(message)
    if (classification === "server-request") {
      if (!this.serverRequestHandlers.size) {
        this.rejectServerRequest(
          message.id!,
          -32601,
          `Unsupported request method: ${message.method ?? "unknown"}`,
        )
        return
      }
      for (const handler of this.serverRequestHandlers) {
        handler(message)
      }
      return
    }

    if (classification === "notification") {
      for (const handler of this.eventHandlers) {
        handler(message)
      }
      return
    }

    const waiter = this.pending.get(jsonRpcIdKey(message.id))
    if (!waiter) {
      return
    }

    clearTimeout(waiter.timeout)
    this.pending.delete(jsonRpcIdKey(message.id))
    if (message.error) {
      if (isCodexAuthTokenInvalidatedMessage(message.error.message)) {
        void markCodexAccountInvalidated(
          this.config.accountId,
          message.error.message,
        )
      }
      waiter.reject(new Error(message.error.message ?? "Codex request failed."))
      return
    }
    waiter.resolve(message)
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

class CodexRuntimeService {
  private readonly runtimes = new Map<string, CodexRuntime>()

  getRuntime(config: CodexRuntimeConfig): CodexRuntime {
    const existing = this.runtimes.get(config.accountId)
    if (existing) {
      return existing
    }

    const runtime = new CodexRuntime(config)
    this.runtimes.set(config.accountId, runtime)
    return runtime
  }

  stopRuntime(accountId: string): void {
    this.runtimes.get(accountId)?.shutdown()
    this.runtimes.delete(accountId)
  }

  shutdown(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.shutdown()
    }
    this.runtimes.clear()
  }
}

export const codexRuntimeService = new CodexRuntimeService()

const invalidatedCodexAccountIds = new Set<string>()

export async function markCodexAccountInvalidated(
  accountId: string,
  cause?: unknown,
): Promise<void> {
  invalidatedCodexAccountIds.add(accountId)
  await prisma.codexAccount.updateMany({
    where: { id: accountId },
    data: {
      status: "INVALIDATED",
      lastAuthUrl: null,
      lastAuthMode: null,
      lastAuthLoginId: null,
      lastAuthUserCode: null,
      lastError: formatCodexAuthInvalidatedMessage(cause),
    },
  })
}

export function clearCodexAccountInvalidated(accountId: string): void {
  invalidatedCodexAccountIds.delete(accountId)
}

export function isCodexAccountMarkedInvalidated(accountId: string): boolean {
  return invalidatedCodexAccountIds.has(accountId)
}

export function isCodexAuthTokenInvalidatedError(error: unknown): boolean {
  return isCodexAuthTokenInvalidatedMessage(
    error instanceof Error ? error.message : String(error ?? ""),
  )
}

function isCodexAuthTokenInvalidatedMessage(message: unknown): boolean {
  if (typeof message !== "string") {
    return false
  }
  const normalized = message.toLowerCase()
  return (
    normalized.includes("token_invalidated") ||
    normalized.includes("authentication token has been invalidated") ||
    (normalized.includes("401") &&
      normalized.includes("unauthorized") &&
      normalized.includes("invalidated"))
  )
}

function formatCodexAuthInvalidatedMessage(cause: unknown): string {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : ""
  const trimmed = message.trim()
  if (!trimmed) {
    return "Codex authentication token was invalidated. Re-authenticate this account."
  }
  return [
    "Codex authentication token was invalidated. Re-authenticate this account.",
    trimmed.length > 700 ? `${trimmed.slice(0, 700)}...` : trimmed,
  ].join("\n")
}

export function buildCodexRuntimeSpawnConfig(
  config: CodexRuntimeConfig,
): CodexRuntimeSpawnConfig {
  const codexHome = resolveAccountCodexHome(config.accountId)
  return {
    command: config.command,
    args: config.args,
    codexHome,
    options: {
      cwd: config.workingDirectory ?? undefined,
      env: {
        ...process.env,
        ...(config.environment ?? {}),
        CODEX_HOME: codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  }
}

export async function listCodexModelsForAccount(config: CodexRuntimeConfig) {
  const runtime = codexRuntimeService.getRuntime(config)
  const response = await runtime.request(
    "model/list",
    { includeHidden: false, limit: 100 },
    30_000,
  )
  return (response.result ?? { data: [], nextCursor: null }) as CodexModelListResponse
}

export async function readCodexRateLimitsForAccount(config: CodexRuntimeConfig) {
  const runtime = codexRuntimeService.getRuntime(config)
  const response = await runtime.request(
    "account/rateLimits/read",
    undefined,
    30_000,
  )
  return response.result as CodexRateLimitsResponse
}

export function resolveAccountCodexHome(accountId: string): string {
  return join(resolveCodexAccountsHome(), accountId)
}

export function ensureAccountCodexHome(accountId: string): string {
  const codexHome = resolveAccountCodexHome(accountId)
  ensureCodexHome(codexHome)
  return codexHome
}

export function resolveCodexSharedChatHome(): string {
  return resolveHomePath(
    process.env.CODEX_SHARED_CHAT_HOME?.trim() ||
      process.env.CODEX_HOME?.trim() ||
      "~/.codex",
  )
}

export function ensureCodexSharedChatHome(): string {
  const sharedChatHome = resolveCodexSharedChatHome()
  mkdirSync(sharedChatHome, { recursive: true, mode: 0o700 })
  chmodSync(sharedChatHome, 0o700)
  return sharedChatHome
}

export function resolveCodexSharedSessionIndexPath(): string {
  return join(resolveCodexSharedChatHome(), "session_index.jsonl")
}

export function resolveCodexSharedStateDatabasePath(): string {
  const sharedChatHome = resolveCodexSharedChatHome()
  const newest = readDirectoryNames(sharedChatHome)
    .filter((name) => /^state_\d+\.sqlite$/i.test(name))
    .sort((left, right) => stateDatabaseVersion(right) - stateDatabaseVersion(left))
    .at(0)
  return join(sharedChatHome, newest ?? "state_5.sqlite")
}

export type CodexMessageClassification =
  | "notification"
  | "server-request"
  | "response"

export function classifyCodexMessage(
  message: CodexJsonRpcResponse,
): CodexMessageClassification {
  if (message.id !== undefined && message.id !== null && message.method) {
    return "server-request"
  }
  if (message.id !== undefined && message.id !== null) {
    return "response"
  }
  return "notification"
}

export function jsonRpcIdKey(id: unknown): string {
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : JSON.stringify(id)
}

function resolveCodexAccountsHome(): string {
  return resolveHomePath(
    process.env.CODEX_ACCOUNTS_HOME?.trim() || "~/.xedoc/accounts",
  )
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

function ensureCodexHome(codexHome: string): void {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  chmodSync(codexHome, 0o700)
  ensureSharedCodexChatStorage(codexHome)
}

function ensureSharedCodexChatStorage(codexHome: string): void {
  const sharedChatHome = ensureCodexSharedChatHome()
  if (resolve(codexHome) === resolve(sharedChatHome)) {
    return
  }

  ensureSharedSessionsLink(codexHome, sharedChatHome)
  ensureSharedSessionIndexLink(codexHome, sharedChatHome)
  ensureSharedStateDatabaseLinks(codexHome, sharedChatHome)
}

function ensureSharedSessionsLink(
  codexHome: string,
  sharedChatHome: string,
): void {
  const target = join(sharedChatHome, "sessions")
  const link = join(codexHome, "sessions")
  mkdirSync(target, { recursive: true, mode: 0o700 })

  if (isSharedFileLink(link, target)) {
    return
  }

  if (pathExists(link)) {
    const readableDirectory = statIfExists(link)?.isDirectory() ?? false
    if (readableDirectory) {
      copyDirectoryContents(link, target)
    }
    renameSync(link, nextBackupPath(link))
  }

  createSharedDirectoryLink(target, link)
}

function ensureSharedSessionIndexLink(
  codexHome: string,
  sharedChatHome: string,
): void {
  const target = join(sharedChatHome, "session_index.jsonl")
  const link = join(codexHome, "session_index.jsonl")
  ensureFile(target, 0o600)

  if (isSharedFileLink(link, target)) {
    return
  }

  if (pathExists(link)) {
    if (statIfExists(link)?.isFile()) {
      appendIndexFile(link, target)
    }
    renameSync(link, nextBackupPath(link))
  }

  createSharedFileLink(target, link)
}

function ensureSharedStateDatabaseLinks(
  codexHome: string,
  sharedChatHome: string,
): void {
  for (const name of sharedStateDatabaseFileNames(codexHome, sharedChatHome)) {
    ensureSharedStateFileLink(codexHome, sharedChatHome, name)
  }
}

function sharedStateDatabaseFileNames(
  codexHome: string,
  sharedChatHome: string,
): string[] {
  const bases = new Set([basename(resolveCodexSharedStateDatabasePath())])
  for (const root of [sharedChatHome, codexHome]) {
    for (const name of readDirectoryNames(root)) {
      if (/^state_\d+\.sqlite$/i.test(name)) {
        bases.add(name)
      }
    }
  }
  return [...bases].flatMap((base) => [base, `${base}-wal`, `${base}-shm`])
}

function ensureSharedStateFileLink(
  codexHome: string,
  sharedChatHome: string,
  name: string,
): void {
  const target = join(sharedChatHome, name)
  const link = join(codexHome, name)
  if (isSharedFileLink(link, target)) {
    return
  }

  const linkInfo = statIfExists(link)
  if (linkInfo?.isFile()) {
    copyFileIfMissing(link, target)
  }
  if (!name.endsWith("-wal") && !name.endsWith("-shm")) {
    ensureFile(target, 0o600)
  }
  if (pathExists(link)) {
    renameSync(link, nextBackupPath(link))
  }
  createSharedFileLink(target, link)
}

function createSharedDirectoryLink(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir")
}

function createSharedFileLink(target: string, link: string): void {
  if (process.platform === "win32") {
    if (!pathExists(target)) {
      return
    }
    linkSync(target, link)
    return
  }
  symlinkSync(target, link, "file")
}

function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function stateDatabaseVersion(name: string): number {
  return Number(/^state_(\d+)\.sqlite$/i.exec(name)?.[1] ?? 0)
}

function ensureFile(path: string, mode: number): void {
  const fd = openSync(path, "a", mode)
  closeSync(fd)
  chmodSync(path, mode)
}

function copyDirectoryContents(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, destinationPath)
      continue
    }
    if (entry.isFile()) {
      copyFileIfMissing(sourcePath, destinationPath)
    }
  }
}

function copyFileIfMissing(source: string, destination: string): void {
  if (pathExists(destination)) {
    return
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  copyFileSync(source, destination)
}

function appendIndexFile(source: string, destination: string): void {
  const content = readFileSync(source, "utf8")
  if (!content.trim()) {
    return
  }
  const destinationContent = readFileSync(destination, "utf8")
  const prefix =
    destinationContent && !destinationContent.endsWith("\n") ? "\n" : ""
  appendFileSync(
    destination,
    `${prefix}${content.endsWith("\n") ? content : `${content}\n`}`,
  )
}

function isSymlinkTo(path: string, target: string): boolean {
  try {
    const info = lstatSync(path)
    if (!info.isSymbolicLink()) {
      return false
    }
    return (
      normalizedResolvedPath(resolve(dirname(path), readlinkSync(path))) ===
      normalizedResolvedPath(resolve(target))
    )
  } catch {
    return false
  }
}

function normalizedResolvedPath(path: string): string {
  const normalized = path.replace(/^\\\\\?\\/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isSharedFileLink(path: string, target: string): boolean {
  if (isSymlinkTo(path, target)) {
    return true
  }
  try {
    const pathInfo = statSync(path)
    const targetInfo = statSync(target)
    return pathInfo.dev === targetInfo.dev && pathInfo.ino === targetInfo.ino
  } catch {
    return false
  }
}

function statIfExists(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function nextBackupPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  let candidate = `${path}.pre-shared-${stamp}`
  let suffix = 1
  while (pathExists(candidate)) {
    candidate = `${path}.pre-shared-${stamp}-${suffix}`
    suffix += 1
  }
  return candidate
}
