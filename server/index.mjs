import "dotenv/config"
import { createHmac, createHash, timingSafeEqual } from "node:crypto"
import { createReadStream, mkdirSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PrismaClient } from "@prisma/client"
import { createRequestListener } from "@react-router/node"
import { Server as SocketServer } from "socket.io"
import { installTerminalSocketHandlers } from "./terminal-socket.mjs"

process.env.NODE_ENV = process.env.NODE_ENV ?? "production"

const DEFAULT_PORT = "6354"
const SERVER_AUTH_ID = "server"
const serverRoot = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(serverRoot, "..")
const options = parseArgs(process.argv.slice(2))
if (options.debug) {
  process.env.XEDOC_DEBUG = "1"
}
const workspaceRoot = resolveHomePath(process.env.CODEX_WORKSPACE_ROOT ?? homedir())
const databasePath = join(workspaceRoot, ".xedoc", "xedoc.db")
const databaseUrl = sqliteDatabaseUrl(databasePath)
process.env.DATABASE_URL = databaseUrl
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
})
const build = await import(
  pathToFileURL(join(packageRoot, "build/server/index.js")).href
)
const clientRoot = join(packageRoot, "build/client")
const requestListener = createRequestListener({
  build,
  mode: process.env.NODE_ENV,
})

const server = createServer((request, response) => {
  if (serveStaticAsset(request, response)) {
    return
  }
  requestListener(request, response)
})

installSocketServer(server)

const port = Number.parseInt(options.port ?? process.env.PORT ?? DEFAULT_PORT, 10)
const host = options.host ?? process.env.HOST ?? "0.0.0.0"

server.listen(port, host, () => {
  console.log(`xedoc listening on http://${host}:${port}`)
})

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--debug") {
      parsed.debug = true
    } else if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.split("=", 2)
      const value = inlineValue ?? argv[++index]
      if (!value || value.startsWith("--")) {
        fail(`${name} requires a value.`)
      }
      assignOption(parsed, name, value)
    } else {
      fail(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function assignOption(parsed, name, value) {
  switch (name) {
    case "--host":
      parsed.host = value
      return
    case "--port":
      parsed.port = value
      return
    default:
      fail(`Unknown option: ${name}`)
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function resolveHomePath(path) {
  if (path === "~") {
    return homedir()
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2))
  }
  return resolve(path)
}

function sqliteDatabaseUrl(path) {
  return `file:${path}?connection_limit=1&pool_timeout=30`
}

function installSocketServer(httpServer) {
  const io = new SocketServer(httpServer, {
    path: "/socket.io",
    serveClient: false,
  })

  io.use((socket, next) => {
    const token = readSocketToken(socket.handshake.auth)
    if (!token) {
      next(new Error("Missing auth token."))
      return
    }
    void verifyToken(token)
      .then(() => next())
      .catch((error) => {
        next(error instanceof Error ? error : new Error("Invalid auth token."))
      })
  })

  io.on("connection", (socket) => {
    socket.on("chat:join", (chatId, ack) => {
      if (!isValidChatId(chatId)) {
        ack?.({ ok: false, message: "Invalid chat id." })
        return
      }
      socket.join(chatRoomName(chatId))
      ack?.({ ok: true })
      socket.emit("chat:connected", { chatId })
    })

    socket.on("chat:leave", (chatId, ack) => {
      if (!isValidChatId(chatId)) {
        ack?.({ ok: false, message: "Invalid chat id." })
        return
      }
      socket.leave(chatRoomName(chatId))
      ack?.({ ok: true })
    })
  })

  installTerminalSocketHandlers(io, { workspaceRoot })

  const state = getRealtimeState()
  const handler = (event) => {
    io.to(chatRoomName(event.chatId)).emit("chat:event", event)
  }
  state.handlers.add(handler)
  httpServer.once("close", () => {
    state.handlers.delete(handler)
    io.close()
  })
}

function serveStaticAsset(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false
  }

  const host = request.headers.host ?? "localhost"
  const url = new URL(request.url ?? "/", `http://${host}`)
  const pathname = decodeURIComponent(url.pathname)
  if (pathname === "/" || pathname.includes("\0")) {
    return false
  }

  const candidate = resolve(clientRoot, `.${normalize(pathname)}`)
  const relativeCandidate = relative(clientRoot, candidate)
  if (
    relativeCandidate.startsWith("..") ||
    relativeCandidate === ".." ||
    isAbsolute(relativeCandidate)
  ) {
    return false
  }

  let stats
  try {
    stats = statSync(candidate)
  } catch {
    return false
  }
  if (!stats.isFile()) {
    return false
  }

  response.statusCode = 200
  response.setHeader("Content-Type", contentType(candidate))
  response.setHeader(
    "Cache-Control",
    pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  )
  if (request.method === "HEAD") {
    response.end()
    return true
  }
  createReadStream(candidate).pipe(response)
  return true
}

function readSocketToken(auth) {
  if (!auth || typeof auth !== "object") {
    return undefined
  }
  const token = auth.token
  return typeof token === "string" && token.trim() ? token.trim() : undefined
}

async function verifyToken(token) {
  const auth = await requireServerAuth()
  const [encodedPayload, signature, extra] = token.split(".")
  if (!encodedPayload || !signature || extra !== undefined) {
    throw new Error("Invalid auth token.")
  }
  if (!constantTimeEqual(signature, sign(encodedPayload, auth.tokenSecret))) {
    throw new Error("Invalid auth token.")
  }

  const payload = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  )
  if (payload?.authHash !== hash(auth.passwordHash)) {
    throw new Error("Auth token has been revoked.")
  }
}

function sign(value, tokenSecret) {
  return createHmac("sha256", tokenSecret).update(value).digest("base64url")
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function requireServerAuth() {
  const auth = await prisma.serverAuth.findUnique({
    where: { id: SERVER_AUTH_ID },
  })
  if (!auth) {
    throw new Error("Server password has not been configured.")
  }
  return auth
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  )
}

function getRealtimeState() {
  globalThis.__xedocRealtimeState__ ??= { handlers: new Set() }
  return globalThis.__xedocRealtimeState__
}

function chatRoomName(chatId) {
  return `chat:${chatId}`
}

function isValidChatId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128
}

function contentType(pathname) {
  switch (extname(pathname)) {
    case ".css":
      return "text/css; charset=utf-8"
    case ".html":
      return "text/html; charset=utf-8"
    case ".js":
      return "text/javascript; charset=utf-8"
    case ".json":
      return "application/json; charset=utf-8"
    case ".map":
      return "application/json; charset=utf-8"
    case ".png":
      return "image/png"
    case ".svg":
      return "image/svg+xml"
    case ".webp":
      return "image/webp"
    case ".woff2":
      return "font/woff2"
    default:
      return "application/octet-stream"
  }
}
