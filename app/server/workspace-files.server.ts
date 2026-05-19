import { open, realpath, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, relative, resolve } from "node:path"
import type { WorkspaceFileResponse } from "@/types"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"
import { resolveDirectory } from "./workspaces.server"

const MAX_VIEW_BYTES = 1_000_000

export type WorkspaceFileMetadata = {
  name: string
  path: string
  relativePath: string
  size: number
}

export async function readChatWorkspaceFile(
  chatId: string,
  inputPath: string,
  requestedLine?: number | null,
): Promise<WorkspaceFileResponse> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { workingDirectory: true },
  })
  if (!chat) {
    throw new HttpError(404, "Chat not found.")
  }
  if (!chat.workingDirectory) {
    throw new HttpError(400, "Chat does not have a working directory.")
  }

  const root = resolveDirectory(chat.workingDirectory)
  const parsed = parseWorkspaceFileReference(inputPath)
  const target = await resolveWorkspaceFilePath(root, parsed.path)
  const info = await statWorkspaceFile(target, root)
  const line = requestedLine ?? parsed.line ?? null
  const bytesToRead = Math.min(info.size, MAX_VIEW_BYTES)
  const buffer = bytesToRead ? await readFilePrefix(target, bytesToRead) : Buffer.alloc(0)
  const isBinary = bufferLooksBinary(buffer)
  const content = isBinary ? undefined : buffer.toString("utf8")
  const lineCount = content ? content.split(/\r?\n/).length : 0

  return {
    content,
    isBinary,
    language: languageForPath(target),
    line,
    lineCount,
    name: info.name,
    path: target,
    relativePath: info.relativePath,
    size: info.size,
    truncated: info.size > MAX_VIEW_BYTES,
  }
}

export async function readWorkspaceFileMetadata(
  rootDirectory: string,
  inputPath: string,
): Promise<WorkspaceFileMetadata> {
  const target = await resolveWorkspaceFilePath(rootDirectory, inputPath)
  return statWorkspaceFile(target, rootDirectory)
}

export async function resolveWorkspaceFilePath(
  rootDirectory: string,
  inputPath: string,
): Promise<string> {
  const trimmed = inputPath.trim()
  if (!trimmed || trimmed.includes("\0")) {
    throw new HttpError(400, "File path is required.")
  }
  const root = await realpath(rootDirectory)
  const candidate = isAbsolute(trimmed) ? trimmed : resolve(root, trimmed)
  let target: string
  try {
    target = await realpath(candidate)
  } catch {
    throw new HttpError(404, "File does not exist.")
  }
  ensureInsideDirectory(root, target)
  return target
}

function parseWorkspaceFileReference(inputPath: string): {
  line?: number | null
  path: string
} {
  const trimmed = safeDecodeURIComponent(inputPath.trim())
  const hashLine = /^(.*)#L(\d+)(?:-\d+)?$/i.exec(trimmed)
  if (hashLine) {
    return {
      line: Number(hashLine[2]),
      path: hashLine[1],
    }
  }
  const colonLine = /^(.+):(\d+)(?::\d+)?$/.exec(trimmed)
  if (colonLine && !/^[A-Za-z]:\\/.test(trimmed)) {
    return {
      line: Number(colonLine[2]),
      path: colonLine[1],
    }
  }
  return { path: trimmed }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function statWorkspaceFile(
  target: string,
  rootDirectory?: string,
): Promise<WorkspaceFileMetadata> {
  const info = await stat(target)
  if (!info.isFile()) {
    throw new HttpError(400, "Workspace path is not a file.")
  }
  const root = rootDirectory ? await realpath(rootDirectory) : null
  return {
    name: basename(target),
    path: target,
    relativePath: root ? relative(root, target) || basename(target) : basename(target),
    size: info.size,
  }
}

function ensureInsideDirectory(root: string, target: string): void {
  const rootRelativePath = relative(root, target)
  if (rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) {
    throw new HttpError(403, "Path is outside the chat working directory.")
  }
}

function bufferLooksBinary(buffer: Buffer): boolean {
  if (!buffer.length) {
    return false
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000))
  if (sample.includes(0)) {
    return true
  }
  const text = sample.toString("utf8")
  return text.includes("\uFFFD")
}

async function readFilePrefix(path: string, bytesToRead: number): Promise<Buffer> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(bytesToRead)
    const result = await handle.read(buffer, 0, bytesToRead, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

function languageForPath(path: string): string | null {
  const extension = extname(path).slice(1).toLowerCase()
  const byExtension: Record<string, string> = {
    cjs: "javascript",
    css: "css",
    go: "go",
    htm: "html",
    html: "html",
    js: "javascript",
    json: "json",
    jsonl: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "typescript",
    yaml: "yaml",
    yml: "yaml",
  }
  return byExtension[extension] ?? (extension || null)
}
