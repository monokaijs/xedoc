import type { ThreadPreference } from "@prisma/client"
import type {
  ChatResponse,
  CodexCollaborationMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexServiceTier,
} from "@/types"
import { readLocalCodexSessionMetadata } from "./local-codex-import.server"
import { prisma } from "./prisma.server"

export type ThreadPreferencePatch = {
  accountId?: string | null
  archivedAt?: Date | null
  autoRotateAccount?: boolean
  collaborationMode?: CodexCollaborationMode
  model?: string | null
  permissionMode?: CodexPermissionMode
  reasoningEffort?: CodexReasoningEffort | null
  serviceTier?: CodexServiceTier | null
  title?: string | null
  workingDirectory?: string | null
}

let migrationPromise: Promise<void> | null = null

export async function migrateLegacyThreadPreferences(): Promise<void> {
  migrationPromise ??= ensureThreadPreferenceTable()
    .then(() =>
      prisma.$executeRawUnsafe(`
        INSERT OR IGNORE INTO "ThreadPreference" (
          "threadId",
          "accountId",
          "autoRotateAccount",
          "title",
          "workingDirectory",
          "model",
          "reasoningEffort",
          "serviceTier",
          "collaborationMode",
          "permissionMode",
          "archivedAt",
          "createdAt",
          "updatedAt"
        )
        SELECT
          "externalThreadId",
          "accountId",
          "autoRotateAccount",
          "title",
          "workingDirectory",
          "model",
          "reasoningEffort",
          "serviceTier",
          "collaborationMode",
          "permissionMode",
          CASE WHEN "status" = 'ARCHIVED' THEN "updatedAt" ELSE NULL END,
          "createdAt",
          "updatedAt"
        FROM "Chat"
        WHERE "externalThreadId" IS NOT NULL AND TRIM("externalThreadId") != ''
      `),
    )
    .then(
      () => undefined,
      () => undefined,
    )
  await migrationPromise
}

export async function listThreadPreferences(): Promise<ThreadPreference[]> {
  await migrateLegacyThreadPreferences()
  return prisma.threadPreference.findMany()
}

export async function getThreadPreference(
  threadId: string,
): Promise<ThreadPreference | null> {
  await migrateLegacyThreadPreferences()
  return prisma.threadPreference.findUnique({ where: { threadId } })
}

export async function upsertThreadPreference(
  threadId: string,
  patch: ThreadPreferencePatch,
): Promise<ThreadPreference> {
  await migrateLegacyThreadPreferences()
  const data = preferencePatchData(patch)
  return prisma.threadPreference.upsert({
    where: { threadId },
    create: {
      threadId,
      ...data,
      updatedAt: new Date(),
    },
    update: data,
  })
}

export async function archiveThreadPreference(
  threadId: string,
): Promise<ThreadPreference> {
  return upsertThreadPreference(threadId, { archivedAt: new Date() })
}

export async function resolveThreadWorkingDirectory(
  threadId: string,
): Promise<string | null> {
  const [session, preference] = await Promise.all([
    readLocalCodexSessionMetadata(threadId),
    getThreadPreference(threadId),
  ])
  return session?.workingDirectory ?? preference?.workingDirectory ?? null
}

export function preferenceToChatFields(
  preference: ThreadPreference | null | undefined,
): Pick<
  ChatResponse,
  | "accountId"
  | "autoRotateAccount"
  | "collaborationMode"
  | "model"
  | "permissionMode"
  | "reasoningEffort"
  | "serviceTier"
  | "workingDirectory"
> {
  return {
    accountId: preference?.accountId ?? null,
    autoRotateAccount: preference?.autoRotateAccount ?? false,
    collaborationMode: normalizeStoredCollaborationMode(
      preference?.collaborationMode,
    ),
    model: preference?.model ?? null,
    permissionMode: normalizeStoredPermissionMode(preference?.permissionMode),
    reasoningEffort:
      (preference?.reasoningEffort as ChatResponse["reasoningEffort"]) ?? null,
    serviceTier:
      (preference?.serviceTier as ChatResponse["serviceTier"]) ?? null,
    workingDirectory: preference?.workingDirectory ?? null,
  }
}

function preferencePatchData(patch: ThreadPreferencePatch) {
  return {
    accountId: patch.accountId,
    archivedAt: patch.archivedAt,
    autoRotateAccount: patch.autoRotateAccount,
    collaborationMode: patch.collaborationMode,
    model: patch.model,
    permissionMode: patch.permissionMode,
    reasoningEffort: patch.reasoningEffort,
    serviceTier: patch.serviceTier,
    title: patch.title,
    workingDirectory: patch.workingDirectory,
  }
}

async function ensureThreadPreferenceTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ThreadPreference" (
      "threadId" TEXT NOT NULL PRIMARY KEY,
      "accountId" TEXT,
      "autoRotateAccount" BOOLEAN NOT NULL DEFAULT false,
      "title" TEXT,
      "workingDirectory" TEXT,
      "model" TEXT,
      "reasoningEffort" TEXT,
      "serviceTier" TEXT,
      "collaborationMode" TEXT NOT NULL DEFAULT 'default',
      "permissionMode" TEXT NOT NULL DEFAULT 'default',
      "archivedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "ThreadPreference_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CodexAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
    )
  `)
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "ThreadPreference_accountId_idx" ON "ThreadPreference"("accountId")',
  )
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "ThreadPreference_archivedAt_idx" ON "ThreadPreference"("archivedAt")',
  )
}

function normalizeStoredCollaborationMode(
  value: string | null | undefined,
): CodexCollaborationMode {
  return value === "plan" ? "plan" : "default"
}

function normalizeStoredPermissionMode(
  value: string | null | undefined,
): CodexPermissionMode {
  return value === "fullAccess" ? "fullAccess" : "default"
}
