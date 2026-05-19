import type { Server } from "socket.io"

export interface TerminalSocketOptions {
  resolveDirectory?: (path: string) => string | Promise<string>
  workspaceRoot?: string
}

export function installTerminalSocketHandlers(
  io: Server,
  options?: TerminalSocketOptions,
): void
