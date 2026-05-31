#!/usr/bin/env node
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { PrismaClient } from "@prisma/client"

const statuses = ["pending", "in_progress", "finished", "failed"]
const databaseUrl = process.env.DATABASE_URL || sqliteDatabaseUrl(workspaceDatabasePath())
const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
})

let buffer = ""

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) {
      void handleLine(trimmed)
    }
  }
})

process.stdin.on("end", () => {
  void prisma.$disconnect().finally(() => process.exit(0))
})

async function handleLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (!message || typeof message !== "object" || message.id === undefined) {
    return
  }

  try {
    const result = await handleRequest(message.method, message.params)
    write({ id: message.id, result })
  } catch (error) {
    write({
      id: message.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

async function handleRequest(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "xedoc-workflow", version: "0.1.0" },
    }
  }
  if (method === "tools/list") {
    return { tools: workflowTools() }
  }
  if (method === "tools/call") {
    const name = params?.name
    const args = params?.arguments ?? {}
    const result = await callTool(name, args)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  }
  if (method === "ping") {
    return {}
  }
  throw new Error(`Unsupported MCP method: ${method}`)
}

async function callTool(name, args) {
  await ensureWorkflowTaskTable()
  switch (name) {
    case "create_task":
      return createTask(args)
    case "update_task":
      return updateTask(args)
    case "list_tasks":
      return listTasks(args)
    case "get_task":
      return getTask(args)
    case "delete_task":
      return deleteTask(args)
    case "get_next_task":
      return getNextTask(args)
    default:
      throw new Error(`Unknown workflow tool: ${name}`)
  }
}

function workflowTools() {
  return [
    {
      name: "create_task",
      description:
        "Create a xedoc Workflow task. Use this whenever the user asks to plan, split, add, or track work. Put implementation guidance, acceptance criteria, and useful context in description.",
      inputSchema: {
        type: "object",
        properties: taskEditableProperties({ requireProjectPath: true }),
        required: ["projectPath", "title"],
        additionalProperties: false,
      },
    },
    {
      name: "update_task",
      description:
        "Update a xedoc Workflow task title, description, project folder, or status.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          ...taskEditableProperties({ requireProjectPath: false }),
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "list_tasks",
      description:
        "List xedoc Workflow tasks, optionally filtered by projectPath or status.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string" },
          status: statusSchema(),
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_task",
      description: "Get one xedoc Workflow task by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_task",
      description: "Delete one xedoc Workflow task by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "get_next_task",
      description:
        "Return the oldest pending or failed task for a project, preferring pending work before failed work.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  ]
}

function taskEditableProperties({ requireProjectPath }) {
  return {
    projectPath: {
      type: "string",
      description: requireProjectPath
        ? "Absolute path to the project folder that owns this task."
        : "Optional absolute path to move this task to a different project folder.",
    },
    title: { type: "string", maxLength: 180 },
    description: {
      type: "string",
      description:
        "Markdown guidance for whoever executes this task, including acceptance criteria when useful.",
      maxLength: 8000,
    },
    status: statusSchema(),
  }
}

function statusSchema() {
  return {
    type: "string",
    enum: statuses,
    description: "Allowed values: pending, in_progress, finished, failed.",
  }
}

async function createTask(args) {
  const now = new Date()
  const id = randomUUID()
  const projectPath = normalizeProjectPath(args.projectPath)
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO "WorkflowTask" (
        "id", "projectPath", "title", "description", "status", "createdAt", "updatedAt"
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    id,
    projectPath,
    normalizeTitle(args.title),
    normalizeDescription(args.description),
    normalizeStatus(args.status ?? "pending"),
    now,
    now,
  )
  return getTask({ id })
}

async function updateTask(args) {
  const id = normalizeId(args.id)
  await readTaskRow(id)
  const updates = []
  const params = []
  if (args.projectPath !== undefined) {
    updates.push('"projectPath" = ?')
    params.push(normalizeProjectPath(args.projectPath))
  }
  if (args.title !== undefined) {
    updates.push('"title" = ?')
    params.push(normalizeTitle(args.title))
  }
  if (args.description !== undefined) {
    updates.push('"description" = ?')
    params.push(normalizeDescription(args.description))
  }
  if (args.status !== undefined) {
    updates.push('"status" = ?')
    params.push(normalizeStatus(args.status))
  }
  if (!updates.length) {
    return getTask({ id })
  }
  updates.push('"updatedAt" = ?')
  params.push(new Date(), id)
  await prisma.$executeRawUnsafe(
    `UPDATE "WorkflowTask" SET ${updates.join(", ")} WHERE "id" = ?`,
    ...params,
  )
  return getTask({ id })
}

async function listTasks(args) {
  const clauses = []
  const params = []
  if (args.projectPath !== undefined) {
    clauses.push('"projectPath" = ?')
    params.push(normalizeProjectPath(args.projectPath))
  }
  if (args.status !== undefined) {
    clauses.push('"status" = ?')
    params.push(normalizeStatus(args.status))
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT "id", "projectPath", "title", "description", "status", "createdAt", "updatedAt"
      FROM "WorkflowTask"
      ${where}
      ORDER BY
        "projectPath" COLLATE NOCASE ASC,
        CASE "status"
          WHEN 'in_progress' THEN 0
          WHEN 'pending' THEN 1
          WHEN 'failed' THEN 2
          WHEN 'finished' THEN 3
          ELSE 4
        END ASC,
        "updatedAt" DESC
    `,
    ...params,
  )
  return { tasks: rows.map(taskResponse) }
}

async function getTask(args) {
  return { task: taskResponse(await readTaskRow(normalizeId(args.id))) }
}

async function deleteTask(args) {
  const id = normalizeId(args.id)
  const task = taskResponse(await readTaskRow(id))
  await prisma.$executeRawUnsafe('DELETE FROM "WorkflowTask" WHERE "id" = ?', id)
  return { deleted: task }
}

async function getNextTask(args) {
  const clauses = ['"status" IN (?, ?)']
  const params = ["pending", "failed"]
  if (args.projectPath !== undefined) {
    clauses.push('"projectPath" = ?')
    params.push(normalizeProjectPath(args.projectPath))
  }
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT "id", "projectPath", "title", "description", "status", "createdAt", "updatedAt"
      FROM "WorkflowTask"
      WHERE ${clauses.join(" AND ")}
      ORDER BY
        CASE "status" WHEN 'pending' THEN 0 ELSE 1 END ASC,
        "createdAt" ASC
      LIMIT 1
    `,
    ...params,
  )
  return { task: rows[0] ? taskResponse(rows[0]) : null }
}

async function readTaskRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT "id", "projectPath", "title", "description", "status", "createdAt", "updatedAt"
      FROM "WorkflowTask"
      WHERE "id" = ?
      LIMIT 1
    `,
    id,
  )
  if (!rows[0]) {
    throw new Error("Task not found.")
  }
  return rows[0]
}

async function ensureWorkflowTaskTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WorkflowTask" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectPath" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "status" TEXT NOT NULL DEFAULT 'pending',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL
    )
  `)
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WorkflowTask_projectPath_idx" ON "WorkflowTask"("projectPath")',
  )
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WorkflowTask_status_idx" ON "WorkflowTask"("status")',
  )
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "WorkflowTask_updatedAt_idx" ON "WorkflowTask"("updatedAt")',
  )
}

function taskResponse(row) {
  return {
    id: row.id,
    projectPath: row.projectPath,
    projectName: basename(row.projectPath) || row.projectPath,
    title: row.title,
    description: row.description,
    status: normalizeStatus(row.status),
    createdAt: dateIso(row.createdAt),
    updatedAt: dateIso(row.updatedAt),
  }
}

function normalizeId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("id is required.")
  }
  return value.trim()
}

function normalizeProjectPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("projectPath is required.")
  }
  const root = ensureWorkspaceRoot()
  const unresolved = isAbsolute(value.trim())
    ? value.trim()
    : join(root, value.trim())
  let path
  try {
    path = realpathSync(resolve(unresolved))
  } catch {
    throw new Error("projectPath must be an existing directory.")
  }
  if (!statSync(path).isDirectory()) {
    throw new Error("projectPath must be a directory.")
  }
  return path
}

function normalizeTitle(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("title is required.")
  }
  const title = value.replace(/\s+/g, " ").trim()
  if (title.length > 180) {
    throw new Error("title must be 180 characters or fewer.")
  }
  return title
}

function normalizeDescription(value) {
  if (value === undefined || value === null) {
    return ""
  }
  if (typeof value !== "string") {
    throw new Error("description must be a string.")
  }
  if (value.length > 8000) {
    throw new Error("description must be 8000 characters or fewer.")
  }
  return value.trim()
}

function normalizeStatus(value) {
  if (statuses.includes(value)) {
    return value
  }
  throw new Error("status must be pending, in_progress, finished, or failed.")
}

function dateIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function ensureWorkspaceRoot() {
  const configured = resolveHomePath(process.env.CODEX_WORKSPACE_ROOT?.trim() || "~")
  if (!existsSync(configured)) {
    mkdirSync(configured, { recursive: true })
  }
  return realpathSync(configured)
}

function workspaceDatabasePath() {
  return join(
    resolveHomePath(process.env.CODEX_WORKSPACE_ROOT?.trim() || homedir()),
    ".xedoc",
    "xedoc.db",
  )
}

function sqliteDatabaseUrl(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  return `file:${path}?connection_limit=1&pool_timeout=30`
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

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
