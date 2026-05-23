import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type {
  GitActionRequest,
  GitActionResponse,
  GitBranchesResponse,
  GitBranch,
  GitCommit,
  GitDiffResponse,
  GitHistoryResponse,
  GitFileStatus,
  GitStatusResponse,
} from "@/types"
import { readInMemoryThreadStatus } from "./chats.server"
import { HttpError } from "./http.server"
import { resolveThreadWorkingDirectory } from "./thread-preferences.server"
import { resolveDirectory } from "./workspaces.server"

const execFileAsync = promisify(execFile)
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const GIT_TIMEOUT_MS = 30_000

type GitContext = {
  cwd: string
  status: string
}

export async function readGitStatus(chatId: string): Promise<GitStatusResponse> {
  const context = await gitContext(chatId)
  const root = await gitRoot(context.cwd)
  if (!root) {
    return emptyGitStatus()
  }

  const branch = await gitBranch(context.cwd)
  const upstream = await tryGit(context.cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ])
  const counts = upstream
    ? await tryGit(context.cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
    : null
  const [behind, ahead] = parseAheadBehind(counts)
  const porcelain = await runGit(context.cwd, ["status", "--porcelain=v1"])
  const changedFiles = parsePorcelainStatus(porcelain)

  return {
    ahead,
    behind,
    branch,
    changedFiles,
    clean: changedFiles.length === 0,
    isRepo: true,
    root,
    upstream,
  }
}

export async function readGitBranches(
  chatId: string,
): Promise<GitBranchesResponse> {
  const context = await gitContext(chatId)
  if (!(await gitRoot(context.cwd))) {
    return {
      branches: [],
      current: null,
      defaultBranch: null,
      isRepo: false,
    }
  }
  const current = await gitBranch(context.cwd)
  const output = await runGit(context.cwd, [
    "branch",
    "--format=%(HEAD)%09%(refname:short)",
  ])
  const branches = output
    .split(/\r?\n/)
    .map((line): GitBranch | null => {
      const [head, name] = line.split("\t")
      const trimmed = name?.trim()
      return trimmed ? { current: head.trim() === "*", name: trimmed } : null
    })
    .filter((branch): branch is GitBranch => !!branch)
  const defaultBranchOutput = await tryGit(context.cwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ])
  const defaultBranch = defaultBranchOutput?.replace(/^origin\//, "") ?? null
  return {
    branches,
    current,
    defaultBranch,
    isRepo: true,
  }
}

export async function readGitDiff(
  chatId: string,
  path?: string | null,
): Promise<GitDiffResponse> {
  const context = await gitContext(chatId)
  if (!(await gitRoot(context.cwd))) {
    return {
      diff: "",
      isRepo: false,
      path: path ?? null,
      stat: "",
    }
  }
  const pathArgs = path ? ["--", path] : ["--"]
  const stat = joinGitOutput(
    await tryGit(context.cwd, ["diff", "--stat", ...pathArgs]),
    await tryGit(context.cwd, ["diff", "--cached", "--stat", ...pathArgs]),
  )
  const diff = joinGitOutput(
    await tryGit(context.cwd, ["diff", "--no-ext-diff", ...pathArgs]),
    await tryGit(context.cwd, ["diff", "--cached", "--no-ext-diff", ...pathArgs]),
  )
  return {
    diff,
    isRepo: true,
    path: path ?? null,
    stat,
  }
}

export async function readGitHistory(chatId: string): Promise<GitHistoryResponse> {
  const context = await gitContext(chatId)
  if (!(await gitRoot(context.cwd))) {
    return {
      commits: [],
      isRepo: false,
    }
  }
  const output = await tryGit(context.cwd, [
    "log",
    "--max-count=80",
    "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e",
    "--decorate=short",
    "--all",
  ])
  return {
    commits: parseGitHistory(output ?? ""),
    isRepo: true,
  }
}

export async function performGitAction(
  chatId: string,
  request: GitActionRequest,
): Promise<GitActionResponse> {
  const context = await gitContext(chatId)
  if (context.status === "RUNNING") {
    throw new HttpError(409, "Git actions are disabled while Codex is running.")
  }
  if (!(await gitRoot(context.cwd))) {
    throw new HttpError(400, "Chat working directory is not a git repository.")
  }

  let output = ""
  if (request.action === "checkout") {
    const branch = requireBranch(request.branch)
    output = await runGit(context.cwd, ["switch", branch])
  } else if (request.action === "createBranch") {
    const branch = requireBranch(request.branch)
    await runGit(context.cwd, ["check-ref-format", "--branch", branch])
    output = await runGit(context.cwd, ["switch", "-c", branch])
  } else if (request.action === "commit") {
    const message = request.message?.trim()
    if (!message) {
      throw new HttpError(400, "Commit message is required.")
    }
    await runGit(context.cwd, ["add", "-A"])
    output = await runGit(context.cwd, ["commit", "-m", message])
  } else if (request.action === "pull") {
    output = await runGit(context.cwd, ["pull", "--rebase", "--autostash"])
  } else if (request.action === "push") {
    const upstream = await tryGit(context.cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ])
    output = upstream
      ? await runGit(context.cwd, ["push"])
      : await pushWithUpstream(context.cwd)
  } else {
    throw new HttpError(400, "Unsupported git action.")
  }

  return {
    message: gitActionLabel(request.action),
    output,
    status: await readGitStatus(chatId),
  }
}

async function gitContext(chatId: string): Promise<GitContext> {
  const workingDirectory = await resolveThreadWorkingDirectory(chatId)
  if (!workingDirectory) {
    throw new HttpError(400, "Chat does not have a working directory.")
  }
  return {
    cwd: resolveDirectory(workingDirectory),
    status: readInMemoryThreadStatus(chatId),
  }
}

async function gitRoot(cwd: string): Promise<string | null> {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"])
}

async function gitBranch(cwd: string): Promise<string | null> {
  return (
    (await tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])) ??
    (await tryGit(cwd, ["rev-parse", "--short", "HEAD"]))
  )
}

async function pushWithUpstream(cwd: string): Promise<string> {
  await runGit(cwd, ["remote", "get-url", "origin"])
  const branch = await gitBranch(cwd)
  if (!branch) {
    throw new HttpError(400, "Cannot push while detached from a branch.")
  }
  return runGit(cwd, ["push", "--set-upstream", "origin", branch])
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args)
  } catch {
    return null
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    })
    return joinGitOutput(result.stdout, result.stderr)
  } catch (error) {
    throw new HttpError(500, gitErrorMessage(error))
  }
}

function emptyGitStatus(): GitStatusResponse {
  return {
    ahead: 0,
    behind: 0,
    branch: null,
    changedFiles: [],
    clean: true,
    isRepo: false,
    root: null,
    upstream: null,
  }
}

function parseAheadBehind(output: string | null): [number, number] {
  const parts = output?.trim().split(/\s+/) ?? []
  const behind = Number(parts[0] ?? 0)
  const ahead = Number(parts[1] ?? 0)
  return [
    Number.isFinite(behind) ? behind : 0,
    Number.isFinite(ahead) ? ahead : 0,
  ]
}

function parsePorcelainStatus(output: string): GitFileStatus[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const staged = line.slice(0, 1)
      const unstaged = line.slice(1, 2)
      const path = line.slice(3).replace(/^"|"$/g, "")
      return {
        path,
        staged,
        status: `${staged}${unstaged}`.trim() || "??",
        unstaged,
      }
    })
}

function parseGitHistory(output: string): GitCommit[] {
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record): GitCommit | null => {
      const [hash, shortHash, authorName, authorEmail, authoredAt, refs, ...subject] =
        record.split("\x1f")
      if (!hash || !shortHash) {
        return null
      }
      return {
        authorEmail: authorEmail ?? "",
        authorName: authorName ?? "",
        authoredAt: authoredAt ?? "",
        hash,
        refs: (refs ?? "")
          .split(",")
          .map((ref) => ref.trim())
          .filter(Boolean),
        shortHash,
        subject: subject.join("\x1f") || "(no subject)",
      }
    })
    .filter((commit): commit is GitCommit => !!commit)
}

function requireBranch(branch: string | undefined): string {
  const trimmed = branch?.trim()
  if (!trimmed) {
    throw new HttpError(400, "Branch name is required.")
  }
  if (trimmed.includes("\0") || trimmed.length > 240) {
    throw new HttpError(400, "Branch name is invalid.")
  }
  return trimmed
}

function joinGitOutput(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join("\n")
}

function gitActionLabel(action: GitActionRequest["action"]): string {
  switch (action) {
    case "checkout":
      return "Branch switched."
    case "createBranch":
      return "Branch created."
    case "commit":
      return "Commit created."
    case "pull":
      return "Pull completed."
    case "push":
      return "Push completed."
  }
}

function gitErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Git command failed."
  }
  const record = error as {
    code?: unknown
    message?: unknown
    stderr?: unknown
    stdout?: unknown
  }
  return (
    joinGitOutput(
      typeof record.stderr === "string" ? record.stderr : null,
      typeof record.stdout === "string" ? record.stdout : null,
    ) ||
    (typeof record.message === "string" ? record.message : null) ||
    "Git command failed."
  )
}
