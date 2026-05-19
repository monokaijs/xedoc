import type { ApiDate } from "./app"

export type TerminalStatus = "running" | "exited"

export interface TerminalSession {
  cols: number
  createdAt: ApiDate
  exitCode?: number | null
  id: string
  projectPath: string
  rows: number
  shell: string
  status: TerminalStatus
  title: string
  updatedAt: ApiDate
}

export interface TerminalCountPayload {
  count: number
}

export interface TerminalProjectPayload {
  projectPath: string
  terminals: TerminalSession[]
}

export interface TerminalOutputPayload {
  data: string
  terminalId: string
}

export interface TerminalExitPayload {
  exitCode?: number | null
  signal?: number | string | null
  terminalId: string
}

export type TerminalAck<TData extends Record<string, unknown> = Record<string, never>> =
  | ({ ok: true } & TData)
  | { message?: string; ok: false }
