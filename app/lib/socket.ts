import type { ChatEventPayloads, ChatEventType, ChatRealtimeEvent } from "@/types"
import { io, type Socket } from "socket.io-client"
import type { WebSession } from "./session-storage"

type ChatSocketHandlers = {
  onEvent: <TType extends ChatEventType>(
    type: TType,
    payload: ChatEventPayloads[TType],
  ) => void
  onOpen?: () => void
  onClose?: () => void
  onError?: (error: unknown) => void
}

type JoinAck = {
  ok: boolean
  message?: string
}

export function connectChatEventSocket(
  session: WebSession,
  chatId: string,
  handlers: ChatSocketHandlers,
): () => void {
  let closed = false
  const socket: Socket = io(session.serverUrl || window.location.origin, {
    auth: { token: session.token },
    path: "/socket.io",
    reconnection: true,
    transports: ["websocket"],
  })

  socket.on("connect", () => {
    socket.emit("chat:join", chatId, (ack: JoinAck | undefined) => {
      if (closed) {
        return
      }
      if (ack?.ok) {
        handlers.onOpen?.()
      } else {
        handlers.onError?.(new Error(ack?.message ?? "Unable to join chat stream."))
      }
    })
  })

  socket.on("chat:event", (event: ChatRealtimeEvent) => {
    if (!closed && event.chatId === chatId) {
      handlers.onEvent(event.type, event.payload)
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

  return () => {
    closed = true
    if (socket.connected) {
      socket.emit("chat:leave", chatId)
    }
    socket.disconnect()
  }
}
