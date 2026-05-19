import "dotenv/config"
import type { Dirent } from "node:fs"
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { mkdir, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type {
  WorkspaceDirectoryResponse,
  WorkspaceEntry,
  WorkspaceEntryType,
} from "@/types"
import { HttpError } from "./http.server"

export async function listDirectory(
  inputPath?: string,
): Promise<WorkspaceDirectoryResponse> {
  const root = ensureWorkspaceRoot()
  const path = resolveWorkspacePath(root, inputPath)
  const entries = await readdir(path, { withFileTypes: true })

  return {
    root,
    path,
    parentPath: path === root ? null : dirname(path),
    entries: entries
      .map((entry) => toWorkspaceEntry(path, entry))
      .sort((left, right) => {
        if (left.type === "directory" && right.type !== "directory") {
          return -1
        }
        if (left.type !== "directory" && right.type === "directory") {
          return 1
        }
        return left.name.localeCompare(right.name)
      }),
  }
}

export async function createDirectory(
  parentPath: string,
  name: string,
): Promise<WorkspaceDirectoryResponse> {
  const root = ensureWorkspaceRoot()
  const parent = resolveWorkspacePath(root, parentPath)
  const directoryName = normalizeDirectoryName(name)
  const target = resolve(parent, directoryName)
  const rootRelativePath = relative(root, target)
  if (rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) {
    throw new HttpError(403, "Path is outside the workspace root.")
  }

  try {
    await mkdir(target)
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new HttpError(409, "Folder already exists.")
    }
    throw error
  }

  return listDirectory(target)
}

export function resolveDirectory(inputPath: string): string {
  const root = ensureWorkspaceRoot()
  return resolveWorkspacePath(root, inputPath)
}

function ensureWorkspaceRoot(): string {
  const configured = resolveHomePath(
    process.env.CODEX_WORKSPACE_ROOT?.trim() || "~",
  )
  if (!existsSync(configured)) {
    mkdirSync(configured, { recursive: true })
  }
  return realpathSync(configured)
}

function resolveWorkspacePath(root: string, inputPath?: string): string {
  const requested = inputPath?.trim()
  const unresolvedPath = requested
    ? isAbsolute(requested)
      ? requested
      : join(root, requested)
    : root
  let path: string
  try {
    path = realpathSync(resolve(unresolvedPath))
  } catch {
    throw new HttpError(400, "Workspace path does not exist.")
  }
  const rootRelativePath = relative(root, path)
  if (rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) {
    throw new HttpError(403, "Path is outside the workspace root.")
  }
  if (!statSync(path).isDirectory()) {
    throw new HttpError(400, "Workspace path is not a directory.")
  }
  return path
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

function toWorkspaceEntry(parentPath: string, entry: Dirent): WorkspaceEntry {
  return {
    name: entry.name,
    path: join(parentPath, entry.name),
    type: getEntryType(entry),
  }
}

function getEntryType(entry: Dirent): WorkspaceEntryType {
  if (entry.isDirectory()) {
    return "directory"
  }
  if (entry.isSymbolicLink()) {
    return "symlink"
  }
  return "file"
}

function normalizeDirectoryName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new HttpError(400, "Folder name is required.")
  }
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new HttpError(400, "Folder name must be a single folder name.")
  }
  return trimmed
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
