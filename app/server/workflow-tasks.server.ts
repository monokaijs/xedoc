import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import type {
  CreateWorkflowTaskRequest,
  UpdateWorkflowTaskRequest,
  WorkflowTaskResponse,
  WorkflowTaskStatus,
} from "@/types"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"
import { resolveDirectory } from "./workspaces.server"

type WorkflowTaskRow = {
  createdAt: Date | string
  description: string
  id: string
  projectPath: string
  status: string
  title: string
  updatedAt: Date | string
}

const workflowTaskStatuses = [
  "pending",
  "in_progress",
  "finished",
  "failed",
] as const satisfies readonly WorkflowTaskStatus[]

export async function listWorkflowTasks(filters: {
  projectPath?: string | null
  status?: string | null
} = {}): Promise<WorkflowTaskResponse[]> {
  await ensureWorkflowTaskTable()
  const clauses: string[] = []
  const params: unknown[] = []
  if (filters.projectPath?.trim()) {
    clauses.push('"projectPath" = ?')
    params.push(resolveDirectory(filters.projectPath))
  }
  if (filters.status?.trim()) {
    clauses.push('"status" = ?')
    params.push(normalizeWorkflowTaskStatus(filters.status))
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = await prisma.$queryRawUnsafe<WorkflowTaskRow[]>(
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
  return rows.map(workflowTaskResponse)
}

export async function getWorkflowTask(id: string): Promise<WorkflowTaskResponse> {
  await ensureWorkflowTaskTable()
  const task = await findWorkflowTaskRow(id)
  if (!task) {
    throw new HttpError(404, "Task not found.")
  }
  return workflowTaskResponse(task)
}

export async function createWorkflowTask(
  dto: CreateWorkflowTaskRequest,
): Promise<WorkflowTaskResponse> {
  await ensureWorkflowTaskTable()
  const now = new Date()
  const id = randomUUID()
  const projectPath = resolveDirectory(dto.projectPath)
  const title = normalizeWorkflowTaskTitle(dto.title)
  const description = normalizeWorkflowTaskDescription(dto.description)
  const status = normalizeWorkflowTaskStatus(dto.status ?? "pending")

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO "WorkflowTask" (
        "id", "projectPath", "title", "description", "status", "createdAt", "updatedAt"
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    id,
    projectPath,
    title,
    description,
    status,
    now,
    now,
  )
  return getWorkflowTask(id)
}

export async function updateWorkflowTask(
  id: string,
  dto: UpdateWorkflowTaskRequest,
): Promise<WorkflowTaskResponse> {
  await ensureWorkflowTaskTable()
  await getWorkflowTask(id)
  const updates: string[] = []
  const params: unknown[] = []

  if (dto.projectPath !== undefined) {
    updates.push('"projectPath" = ?')
    params.push(resolveDirectory(dto.projectPath))
  }
  if (dto.title !== undefined) {
    updates.push('"title" = ?')
    params.push(normalizeWorkflowTaskTitle(dto.title))
  }
  if (dto.description !== undefined) {
    updates.push('"description" = ?')
    params.push(normalizeWorkflowTaskDescription(dto.description))
  }
  if (dto.status !== undefined) {
    updates.push('"status" = ?')
    params.push(normalizeWorkflowTaskStatus(dto.status))
  }

  if (!updates.length) {
    return getWorkflowTask(id)
  }

  updates.push('"updatedAt" = ?')
  params.push(new Date(), id)
  await prisma.$executeRawUnsafe(
    `UPDATE "WorkflowTask" SET ${updates.join(", ")} WHERE "id" = ?`,
    ...params,
  )
  return getWorkflowTask(id)
}

export async function deleteWorkflowTask(
  id: string,
): Promise<WorkflowTaskResponse> {
  const task = await getWorkflowTask(id)
  await prisma.$executeRawUnsafe('DELETE FROM "WorkflowTask" WHERE "id" = ?', id)
  return task
}

export async function ensureWorkflowTaskTable(): Promise<void> {
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

function normalizeWorkflowTaskTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim()
  if (!title) {
    throw new HttpError(400, "title is required.")
  }
  if (title.length > 180) {
    throw new HttpError(400, "title must be 180 characters or fewer.")
  }
  return title
}

function normalizeWorkflowTaskDescription(value: string | undefined): string {
  const description = value?.trim() ?? ""
  if (description.length > 8000) {
    throw new HttpError(400, "description must be 8000 characters or fewer.")
  }
  return description
}

function normalizeWorkflowTaskStatus(value: string): WorkflowTaskStatus {
  if (workflowTaskStatuses.includes(value as WorkflowTaskStatus)) {
    return value as WorkflowTaskStatus
  }
  throw new HttpError(400, "status is invalid.")
}

async function findWorkflowTaskRow(
  id: string,
): Promise<WorkflowTaskRow | null> {
  const rows = await prisma.$queryRawUnsafe<WorkflowTaskRow[]>(
    `
      SELECT "id", "projectPath", "title", "description", "status", "createdAt", "updatedAt"
      FROM "WorkflowTask"
      WHERE "id" = ?
      LIMIT 1
    `,
    id,
  )
  return rows[0] ?? null
}

function workflowTaskResponse(row: WorkflowTaskRow): WorkflowTaskResponse {
  const status = normalizeWorkflowTaskStatus(row.status)
  return {
    id: row.id,
    projectName: basename(row.projectPath) || row.projectPath,
    projectPath: row.projectPath,
    title: row.title,
    description: row.description,
    status,
    createdAt: dateIso(row.createdAt),
    updatedAt: dateIso(row.updatedAt),
  }
}

function dateIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
