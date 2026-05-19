import type {
  TerminalAck,
  TerminalCountPayload,
  TerminalExitPayload,
  TerminalOutputPayload,
  TerminalProjectPayload,
  TerminalSession,
} from "@/types"
import { io, type Socket } from "socket.io-client"
import type { WebSession } from "./session-storage"

type TerminalSocketHandlers = {
  onClose?: () => void
  onCount?: (payload: TerminalCountPayload) => void
  onError?: (error: unknown) => void
  onExit?: (payload: TerminalExitPayload) => void
  onOpen?: () => void
  onOutput?: (payload: TerminalOutputPayload) => void
  onProject?: (payload: TerminalProjectPayload) => void
}

export type TerminalSocket = Socket

export type TerminalRequestEvent =
  | "terminal:attach"
  | "terminal:close"
  | "terminal:create"
  | "terminal:detach"
  | "terminal:input"
  | "terminal:list"
  | "terminal:project:join"
  | "terminal:project:leave"
  | "terminal:resize"
  | "terminal:title"

export function connectTerminalSocket(
  session: WebSession,
  handlers: TerminalSocketHandlers,
): { disconnect: () => void; socket: TerminalSocket } {
  let closed = false
  const socket: Socket = io(session.serverUrl || window.location.origin, {
    auth: { token: session.token },
    path: "/socket.io",
    reconnection: true,
    transports: ["websocket"],
  })

  socket.on("connect", () => {
    if (!closed) {
      handlers.onOpen?.()
    }
  })
  socket.on("disconnect", () => {
    if (!closed) {
      handlers.onClose?.()
    }
  })
  socket.on("connect_error", (error) => {
    if (!closed) {
      handlers.onError?.(error)
    }
  })
  socket.on("terminal:count", (payload: TerminalCountPayload) => {
    if (!closed) {
      handlers.onCount?.(payload)
    }
  })
  socket.on("terminal:project", (payload: TerminalProjectPayload) => {
    if (!closed) {
      handlers.onProject?.(payload)
    }
  })
  socket.on("terminal:output", (payload: TerminalOutputPayload) => {
    if (!closed) {
      handlers.onOutput?.(payload)
    }
  })
  socket.on("terminal:exit", (payload: TerminalExitPayload) => {
    if (!closed) {
      handlers.onExit?.(payload)
    }
  })

  return {
    disconnect: () => {
      closed = true
      socket.disconnect()
    },
    socket,
  }
}

export function terminalRequest<TResponse extends Record<string, unknown>>(
  socket: TerminalSocket | null,
  event: TerminalRequestEvent,
  payload: Record<string, unknown>,
): Promise<TResponse> {
  if (!socket) {
    return Promise.reject(new Error("Terminal socket is not connected."))
  }
  return new Promise((resolve, reject) => {
    socket
      .timeout(15_000)
      .emit(event, payload, (error: Error | null, ack?: TerminalAck<TResponse>) => {
        if (error) {
          reject(error)
          return
        }
        if (!ack?.ok) {
          reject(new Error(ack?.message ?? "Terminal request failed."))
          return
        }
        const data = { ...ack }
        delete (data as { ok?: boolean }).ok
        resolve(data as TResponse)
      })
  })
}

export type TerminalAttachResponse = {
  replay: string
  terminal: TerminalSession
}

export type TerminalCreateResponse = {
  projectPath: string
  terminal: TerminalSession
  terminals: TerminalSession[]
}

export type TerminalListResponse = {
  projectPath: string
  terminals: TerminalSession[]
}

export type TerminalCloseResponse = {
  projectPath: string
  terminalId: string
  terminals: TerminalSession[]
}
