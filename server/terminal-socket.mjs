import pty from "@lydell/node-pty"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"

const REPLAY_LIMIT_BYTES = 1_000_000
const MAX_TERMINAL_INPUT_BYTES = 1_000_000
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

const installedServers = new WeakSet()
const terminals = new Map()

let exitHandlerInstalled = false

export function installTerminalSocketHandlers(io, options = {}) {
  if (installedServers.has(io)) {
    return
  }
  installedServers.add(io)
  installProcessExitHandler()

  const resolveDirectory = options.resolveDirectory ?? ((path) =>
    resolveWorkspaceDirectory(path, options.workspaceRoot))

  io.on("connection", (socket) => {
    emitCount(socket)

    socket.on("terminal:project:join", (payload, ack) => {
      void handleAck(ack, async () => {
        const projectPath = await resolveProjectPath(resolveDirectory, payload)
        joinProjectRoom(socket, projectPath)
        return {
          projectPath,
          terminals: listProjectTerminals(projectPath),
        }
      })
    })

    socket.on("terminal:project:leave", (payload, ack) => {
      void handleAck(ack, async () => {
        const projectPath = await resolveProjectPath(resolveDirectory, payload)
        socket.leave(projectRoomName(projectPath))
        if (socket.data.terminalProjectPath === projectPath) {
          socket.data.terminalProjectPath = null
        }
        return { projectPath }
      })
    })

    socket.on("terminal:list", (payload, ack) => {
      void handleAck(ack, async () => {
        const projectPath = await resolveProjectPath(resolveDirectory, payload)
        return {
          projectPath,
          terminals: listProjectTerminals(projectPath),
        }
      })
    })

    socket.on("terminal:create", (payload, ack) => {
      void handleAck(ack, async () => {
        const projectPath = await resolveProjectPath(resolveDirectory, payload)
        joinProjectRoom(socket, projectPath)
        const terminal = createTerminal(projectPath, payload)
        broadcastProject(io, projectPath)
        broadcastCount(io)
        return {
          projectPath,
          terminal: serializeTerminal(terminal),
          terminals: listProjectTerminals(projectPath),
        }
      })
    })

    socket.on("terminal:attach", (payload, ack) => {
      void handleAck(ack, async () => {
        const terminal = requireTerminal(readTerminalId(payload))
        socket.join(terminalRoomName(terminal.id))
        return {
          replay: terminal.replay.join(""),
          terminal: serializeTerminal(terminal),
        }
      })
    })

    socket.on("terminal:detach", (payload, ack) => {
      void handleAck(ack, async () => {
        const terminalId = readTerminalId(payload)
        socket.leave(terminalRoomName(terminalId))
        return { terminalId }
      })
    })

    socket.on("terminal:input", (payload, ack) => {
      void handleAck(ack, async () => {
        const terminal = requireTerminal(readTerminalId(payload))
        if (terminal.status !== "running" || !terminal.pty) {
          throw new Error("Terminal is not running.")
        }
        const data = readTerminalInputData(payload?.data)
        if (Buffer.byteLength(data, "utf8") > MAX_TERMINAL_INPUT_BYTES) {
          throw new Error("Terminal input is too large.")
        }
        terminal.pty.write(data)
        return { terminalId: terminal.id }
      })
    })

    socket.on("terminal:resize", (payload, ack) => {
      void handleAck(ack, async () => {
        const terminal = requireTerminal(readTerminalId(payload))
        const cols = normalizeDimension(payload?.cols, DEFAULT_COLS, 8, 500)
        const rows = normalizeDimension(payload?.rows, DEFAULT_ROWS, 4, 300)
        terminal.cols = cols
        terminal.rows = rows
        terminal.updatedAt = new Date()
        if (terminal.status === "running" && terminal.pty) {
          terminal.pty.resize(cols, rows)
        }
        return { cols, rows, terminalId: terminal.id }
      })
    })

    socket.on("terminal:title", (payload, ack) => {
      void handleAck(ack, async () => {
        const terminal = requireTerminal(readTerminalId(payload))
        const title = normalizeTitle(readString(payload?.title, "title"))
        if (title && title !== terminal.title) {
          terminal.title = title
          terminal.updatedAt = new Date()
          broadcastProject(io, terminal.projectPath)
        }
        return { terminal: serializeTerminal(terminal) }
      })
    })

    socket.on("terminal:close", (payload, ack) => {
      void handleAck(ack, async () => {
        const terminal = requireTerminal(readTerminalId(payload))
        closeTerminal(terminal)
        broadcastProject(io, terminal.projectPath)
        broadcastCount(io)
        return {
          projectPath: terminal.projectPath,
          terminalId: terminal.id,
          terminals: listProjectTerminals(terminal.projectPath),
        }
      })
    })
  })
}

function createTerminal(projectPath, payload) {
  const id = randomUUID()
  const cols = normalizeDimension(payload?.cols, DEFAULT_COLS, 8, 500)
  const rows = normalizeDimension(payload?.rows, DEFAULT_ROWS, 4, 300)
  const shell = defaultShell()
  const ptyProcess = pty.spawn(shell.command, shell.args, {
    cols,
    cwd: projectPath,
    env: {
      ...process.env,
      COLORTERM: "truecolor",
      PWD: projectPath,
      TERM: "xterm-256color",
    },
    name: "xterm-256color",
    rows,
  })
  const now = new Date()
  const terminal = {
    cols,
    createdAt: now,
    exitCode: null,
    id,
    projectPath,
    pty: ptyProcess,
    replay: [],
    replayBytes: 0,
    rows,
    shell: shell.command,
    status: "running",
    title: defaultTitle(projectPath),
    titleBuffer: "",
    updatedAt: now,
  }
  terminals.set(id, terminal)

  ptyProcess.onData((data) => {
    appendReplay(terminal, data)
    const title = extractTitle(terminal, data)
    if (title && title !== terminal.title) {
      terminal.title = title
      terminal.updatedAt = new Date()
      broadcastProjectForTerminal(terminal)
    }
    const io = terminal.io
    io?.to(terminalRoomName(id)).emit("terminal:output", {
      data,
      terminalId: id,
    })
  })

  ptyProcess.onExit(({ exitCode, signal }) => {
    terminal.exitCode = exitCode
    terminal.pty = null
    terminal.status = "exited"
    terminal.updatedAt = new Date()
    terminal.io?.to(terminalRoomName(id)).emit("terminal:exit", {
      exitCode,
      signal,
      terminalId: id,
    })
    broadcastProjectForTerminal(terminal)
    if (terminal.io) {
      broadcastCount(terminal.io)
    }
  })

  return terminal
}

function closeTerminal(terminal) {
  terminals.delete(terminal.id)
  if (terminal.pty) {
    try {
      terminal.pty.kill()
    } catch {
      // The process may already have exited.
    }
  }
  terminal.pty = null
  terminal.status = "closed"
  terminal.updatedAt = new Date()
}

function joinProjectRoom(socket, projectPath) {
  const previousProjectPath = socket.data.terminalProjectPath
  if (previousProjectPath && previousProjectPath !== projectPath) {
    socket.leave(projectRoomName(previousProjectPath))
  }
  socket.data.terminalProjectPath = projectPath
  socket.join(projectRoomName(projectPath))
}

function listProjectTerminals(projectPath) {
  return [...terminals.values()]
    .filter((terminal) => terminal.projectPath === projectPath && terminal.status !== "closed")
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .map(serializeTerminal)
}

function serializeTerminal(terminal) {
  return {
    cols: terminal.cols,
    createdAt: terminal.createdAt.toISOString(),
    exitCode: terminal.exitCode,
    id: terminal.id,
    projectPath: terminal.projectPath,
    rows: terminal.rows,
    shell: terminal.shell,
    status: terminal.status,
    title: terminal.title,
    updatedAt: terminal.updatedAt.toISOString(),
  }
}

function appendReplay(terminal, data) {
  terminal.replay.push(data)
  terminal.replayBytes += Buffer.byteLength(data, "utf8")
  while (terminal.replayBytes > REPLAY_LIMIT_BYTES && terminal.replay.length > 1) {
    const removed = terminal.replay.shift()
    terminal.replayBytes -= Buffer.byteLength(removed, "utf8")
  }
}

function extractTitle(terminal, data) {
  terminal.titleBuffer = (terminal.titleBuffer + data).slice(-4096)
  const matches = [
    ...terminal.titleBuffer.matchAll(/\x1b\](?:0|1|2);([^\x07]*)\x07/g),
    ...terminal.titleBuffer.matchAll(/\x1b\](?:0|1|2);([\s\S]*?)\x1b\\/g),
  ]
  const last = matches.at(-1)
  return last ? normalizeTitle(last[1]) : null
}

function normalizeTitle(value) {
  const title = value.replace(/[\x00-\x1f\x7f]/g, "").trim()
  return title ? title.slice(0, 120) : null
}

function defaultTitle(projectPath) {
  return basename(projectPath) || "Shell"
}

function defaultShell() {
  if (process.platform === "win32") {
    return { args: [], command: process.env.COMSPEC || "cmd.exe" }
  }
  return { args: [], command: process.env.SHELL || "/bin/bash" }
}

async function resolveProjectPath(resolveDirectory, payload) {
  const rawProjectPath = readString(payload?.projectPath, "projectPath")
  return resolveDirectory(rawProjectPath)
}

function resolveWorkspaceDirectory(inputPath, configuredRoot) {
  const root = ensureWorkspaceRoot(configuredRoot)
  const requested = inputPath.trim()
  const unresolvedPath = requested
    ? isAbsolute(requested)
      ? requested
      : join(root, requested)
    : root
  let path
  try {
    path = realpathSync(resolve(unresolvedPath))
  } catch {
    throw new Error("Workspace path does not exist.")
  }
  const rootRelativePath = relative(root, path)
  if (rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) {
    throw new Error("Path is outside the workspace root.")
  }
  if (!statSync(path).isDirectory()) {
    throw new Error("Workspace path is not a directory.")
  }
  return path
}

function ensureWorkspaceRoot(configuredRoot) {
  const configured = resolveHomePath(configuredRoot?.trim() || process.env.CODEX_WORKSPACE_ROOT?.trim() || "~")
  if (!existsSync(configured)) {
    mkdirSync(configured, { recursive: true })
  }
  return realpathSync(configured)
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

function requireTerminal(terminalId) {
  const terminal = terminals.get(terminalId)
  if (!terminal || terminal.status === "closed") {
    throw new Error("Terminal not found.")
  }
  return terminal
}

function readTerminalId(payload) {
  return readString(payload?.terminalId, "terminalId")
}

function readString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required.`)
  }
  return value
}

function readTerminalInputData(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("data is required.")
  }
  return value
}

function normalizeDimension(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ""), 10)
  if (!Number.isFinite(number)) {
    return fallback
  }
  return Math.max(min, Math.min(max, number))
}

async function handleAck(ack, action) {
  try {
    const data = await action()
    ack?.({ ok: true, ...data })
  } catch (error) {
    ack?.({
      message: error instanceof Error ? error.message : "Terminal request failed.",
      ok: false,
    })
  }
}

function projectRoomName(projectPath) {
  return `terminal:project:${Buffer.from(projectPath, "utf8").toString("base64url")}`
}

function terminalRoomName(terminalId) {
  return `terminal:${terminalId}`
}

function runningTerminalCount() {
  return [...terminals.values()].filter((terminal) => terminal.status === "running").length
}

function emitCount(socket) {
  socket.emit("terminal:count", { count: runningTerminalCount() })
}

function broadcastCount(io) {
  io.emit("terminal:count", { count: runningTerminalCount() })
}

function broadcastProject(io, projectPath) {
  for (const terminal of terminals.values()) {
    if (terminal.projectPath === projectPath) {
      terminal.io = io
    }
  }
  io.to(projectRoomName(projectPath)).emit("terminal:project", {
    projectPath,
    terminals: listProjectTerminals(projectPath),
  })
}

function broadcastProjectForTerminal(terminal) {
  if (!terminal.io) {
    return
  }
  broadcastProject(terminal.io, terminal.projectPath)
}

function installProcessExitHandler() {
  if (exitHandlerInstalled) {
    return
  }
  exitHandlerInstalled = true
  process.once("exit", () => {
    for (const terminal of terminals.values()) {
      if (terminal.pty) {
        try {
          terminal.pty.kill()
        } catch {
          // Process exit is already in progress.
        }
      }
    }
  })
}
