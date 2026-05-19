import type { Server as HttpServer } from "node:http"
import { Server as SocketServer } from "socket.io"
import { installTerminalSocketHandlers } from "../../server/terminal-socket.mjs"
import { verifyBearer } from "./auth.server"
import { subscribePublishedChatEvents } from "./realtime.server"
import { resolveDirectory } from "./workspaces.server"

type Ack = (response: { ok: boolean; message?: string }) => void

const installedServers = new WeakSet<HttpServer>()

export function installChatSocketServer(httpServer: HttpServer): void {
  if (installedServers.has(httpServer)) {
    return
  }
  installedServers.add(httpServer)

  const io = new SocketServer(httpServer, {
    cors: {
      credentials: true,
      origin: true,
    },
    path: "/socket.io",
    serveClient: false,
  })

  io.use((socket, next) => {
    const token = readSocketToken(socket.handshake.auth)
    if (!token) {
      next(new Error("Missing auth token."))
      return
    }
    void verifyBearer(`Bearer ${token}`)
      .then((auth) => {
        socket.data.auth = auth
        next()
      })
      .catch((error) => {
        next(error instanceof Error ? error : new Error("Invalid auth token."))
      })
  })

  io.on("connection", (socket) => {
    socket.on("chat:join", (chatId: unknown, ack?: Ack) => {
      if (!isValidChatId(chatId)) {
        ack?.({ ok: false, message: "Invalid chat id." })
        return
      }
      socket.join(chatRoomName(chatId))
      ack?.({ ok: true })
      socket.emit("chat:connected", { chatId })
    })

    socket.on("chat:leave", (chatId: unknown, ack?: Ack) => {
      if (!isValidChatId(chatId)) {
        ack?.({ ok: false, message: "Invalid chat id." })
        return
      }
      socket.leave(chatRoomName(chatId))
      ack?.({ ok: true })
    })
  })

  installTerminalSocketHandlers(io, { resolveDirectory })

  const unsubscribe = subscribePublishedChatEvents((event) => {
    io.to(chatRoomName(event.chatId)).emit("chat:event", event)
  })

  httpServer.once("close", () => {
    unsubscribe()
    io.close()
    installedServers.delete(httpServer)
  })
}

export function chatRoomName(chatId: string): string {
  return `chat:${chatId}`
}

function readSocketToken(auth: unknown): string | undefined {
  if (!auth || typeof auth !== "object") {
    return undefined
  }
  const token = (auth as { token?: unknown }).token
  return typeof token === "string" && token.trim() ? token.trim() : undefined
}

function isValidChatId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128
}
