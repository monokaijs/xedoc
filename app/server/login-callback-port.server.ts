import { execFile } from "node:child_process"
import { createServer } from "node:net"
import { promisify } from "node:util"
import type {
  LoginCallbackPortProcess,
  LoginCallbackPortStatus,
} from "@/types"
import { HttpError } from "./http.server"

const execFileAsync = promisify(execFile)

const LOGIN_CALLBACK_HOST = "127.0.0.1"
const LOGIN_CALLBACK_PORT = normalizeCallbackPort(
  process.env.CODEX_LOGIN_CALLBACK_PORT,
)

export async function readLoginCallbackPortStatus(): Promise<LoginCallbackPortStatus> {
  const inUse = await isCallbackPortInUse()
  const processes = inUse ? await findCallbackPortProcesses() : []
  return buildStatus(inUse, processes)
}

export async function killLoginCallbackPortProcess(): Promise<LoginCallbackPortStatus> {
  const status = await readLoginCallbackPortStatus()
  if (!status.inUse) {
    return status
  }

  const processIds = status.processes
    .map((entry) => entry.pid)
    .filter((pid) => pid > 0 && pid !== process.pid)

  if (!processIds.length) {
    throw new HttpError(
      409,
      status.processes.some((entry) => entry.pid === process.pid)
        ? "The current xedoc server owns the login callback port and cannot kill itself."
        : "No killable process was found for the login callback port.",
    )
  }

  const killedProcessIds: number[] = []
  for (const pid of Array.from(new Set(processIds))) {
    try {
      process.kill(pid, "SIGTERM")
      killedProcessIds.push(pid)
    } catch (error) {
      if (!isMissingProcessError(error)) {
        throw new HttpError(
          500,
          `Could not kill process ${pid}: ${readErrorMessage(error)}`,
        )
      }
    }
  }

  await delay(600)
  const nextStatus = await readLoginCallbackPortStatus()
  return {
    ...nextStatus,
    killedProcessIds,
  }
}

function buildStatus(
  inUse: boolean,
  processes: LoginCallbackPortProcess[],
  killedProcessIds?: number[],
): LoginCallbackPortStatus {
  const hasCurrentProcess = processes.some((entry) => entry.pid === process.pid)
  return {
    checkedAt: new Date().toISOString(),
    host: LOGIN_CALLBACK_HOST,
    inUse,
    killable: processes.some((entry) => entry.pid > 0 && entry.pid !== process.pid),
    killedProcessIds,
    port: LOGIN_CALLBACK_PORT,
    processes,
    message: inUse
      ? hasCurrentProcess
        ? "The current xedoc server owns the login callback port."
        : "The Codex login callback port is already in use."
      : "The Codex login callback port is available.",
  }
}

function isCallbackPortInUse(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer()

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(true)
        return
      }
      reject(error)
    })

    server.listen(
      {
        host: LOGIN_CALLBACK_HOST,
        port: LOGIN_CALLBACK_PORT,
      },
      () => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve(false)
        })
      },
    )
  })
}

async function findCallbackPortProcesses(): Promise<LoginCallbackPortProcess[]> {
  if (process.platform === "win32") {
    return findCallbackPortProcessesWithNetstat()
  }

  const lsofProcesses = await findCallbackPortProcessesWithLsof()
  if (lsofProcesses.length) {
    return lsofProcesses
  }

  return findCallbackPortProcessesWithSs()
}

async function findCallbackPortProcessesWithLsof(): Promise<LoginCallbackPortProcess[]> {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${LOGIN_CALLBACK_PORT}`,
      "-sTCP:LISTEN",
      "-F",
      "pcLn",
    ])
    return parseLsofFieldOutput(stdout)
  } catch {
    return []
  }
}

async function findCallbackPortProcessesWithSs(): Promise<LoginCallbackPortProcess[]> {
  try {
    const { stdout } = await execFileAsync("ss", ["-ltnp"])
    return parseSsOutput(stdout)
  } catch {
    return []
  }
}

async function findCallbackPortProcessesWithNetstat(): Promise<LoginCallbackPortProcess[]> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"])
    return parseNetstatOutput(stdout)
  } catch {
    return []
  }
}

function parseLsofFieldOutput(output: string): LoginCallbackPortProcess[] {
  const processes: LoginCallbackPortProcess[] = []
  let current: LoginCallbackPortProcess | null = null

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const field = line.slice(0, 1)
    const value = line.slice(1)
    if (field === "p") {
      if (current) {
        processes.push(current)
      }
      current = { pid: Number(value) }
      continue
    }
    if (!current) {
      continue
    }
    if (field === "c") {
      current.command = value
    } else if (field === "L") {
      current.user = value
    } else if (field === "n") {
      current.address = value
    }
  }

  if (current) {
    processes.push(current)
  }

  return dedupeProcesses(processes.filter((entry) => Number.isFinite(entry.pid)))
}

function parseSsOutput(output: string): LoginCallbackPortProcess[] {
  const processes: LoginCallbackPortProcess[] = []
  const portPattern = new RegExp(`:${LOGIN_CALLBACK_PORT}\\b`)

  for (const line of output.split(/\r?\n/)) {
    if (!portPattern.test(line) || !line.includes("LISTEN")) {
      continue
    }

    const ownerPattern = /"([^"]+)",pid=(\d+)/g
    let owner: RegExpExecArray | null
    while ((owner = ownerPattern.exec(line))) {
      processes.push({
        command: owner[1],
        pid: Number(owner[2]),
        address: line.trim(),
      })
    }
  }

  return dedupeProcesses(processes.filter((entry) => Number.isFinite(entry.pid)))
}

function parseNetstatOutput(output: string): LoginCallbackPortProcess[] {
  const processes: LoginCallbackPortProcess[] = []
  const portPattern = new RegExp(`:${LOGIN_CALLBACK_PORT}\\s`)

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.includes("LISTENING") || !portPattern.test(trimmed)) {
      continue
    }

    const parts = trimmed.split(/\s+/)
    const pid = Number(parts.at(-1))
    if (Number.isFinite(pid)) {
      processes.push({ pid, address: trimmed })
    }
  }

  return dedupeProcesses(processes)
}

function dedupeProcesses(
  processes: LoginCallbackPortProcess[],
): LoginCallbackPortProcess[] {
  const byPid = new Map<number, LoginCallbackPortProcess>()
  for (const processEntry of processes) {
    if (!byPid.has(processEntry.pid)) {
      byPid.set(processEntry.pid, processEntry)
    }
  }
  return Array.from(byPid.values()).sort((left, right) => left.pid - right.pid)
}

function normalizeCallbackPort(value: string | undefined): number {
  const parsed = Number(value ?? 1457)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return 1457
  }
  return parsed
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isMissingProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  )
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}
