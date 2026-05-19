import "dotenv/config"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
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
}
