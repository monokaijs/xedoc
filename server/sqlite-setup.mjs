import "dotenv/config"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export async function setupSqliteDatabase() {
  const databasePath = workspaceDatabasePath()
  const databaseUrl = sqliteDatabaseUrl(databasePath)
  process.env.DATABASE_URL = databaseUrl
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 })
  const { PrismaClient } = await import("@prisma/client")
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  })
  try {
    await migrateLegacyUserScopedTables(prisma)
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON")
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL")
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 30000")
    for (const statement of schemaStatements) {
      try {
        await prisma.$executeRawUnsafe(statement)
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error
        }
      }
    }
    await migrateLegacyChatPreferences(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

async function migrateLegacyUserScopedTables(prisma) {
  await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF")
  try {
    if (await tableHasColumn(prisma, "CodexAccount", "userId")) {
      await rebuildCodexAccountTable(prisma)
    }
    if (await tableHasColumn(prisma, "Chat", "userId")) {
      await rebuildChatTable(prisma)
    }
  } finally {
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON")
  }
}

async function tableHasColumn(prisma, tableName, columnName) {
  try {
    const columns = await prisma.$queryRawUnsafe(`PRAGMA table_info("${tableName}")`)
    return columns.some((column) => column.name === columnName)
  } catch {
    return false
  }
}

async function rebuildCodexAccountTable(prisma) {
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "CodexAccount_new"')
  await prisma.$executeRawUnsafe(createCodexAccountTable("CodexAccount_new"))
  await prisma.$executeRawUnsafe(`
    INSERT INTO "CodexAccount_new" (
      "id",
      "displayName",
      "status",
      "command",
      "args",
      "environment",
      "defaultModel",
      "defaultPermissionMode",
      "defaultReasoningEffort",
      "defaultServiceTier",
      "lastAuthUrl",
      "lastAuthMode",
      "lastAuthLoginId",
      "lastAuthUserCode",
      "lastError",
      "createdAt",
      "updatedAt"
    )
    SELECT
      "id",
      "displayName",
      "status",
      "command",
      "args",
      "environment",
      ${await selectColumnOrNull(prisma, "CodexAccount", "defaultModel")},
      ${await selectColumnOrNull(prisma, "CodexAccount", "defaultPermissionMode")},
      ${await selectColumnOrNull(prisma, "CodexAccount", "defaultReasoningEffort")},
      ${await selectColumnOrNull(prisma, "CodexAccount", "defaultServiceTier")},
      "lastAuthUrl",
      ${await selectColumnOrNull(prisma, "CodexAccount", "lastAuthMode")},
      ${await selectColumnOrNull(prisma, "CodexAccount", "lastAuthLoginId")},
      ${await selectColumnOrNull(prisma, "CodexAccount", "lastAuthUserCode")},
      "lastError",
      "createdAt",
      "updatedAt"
    FROM "CodexAccount"
  `)
  await prisma.$executeRawUnsafe('DROP TABLE "CodexAccount"')
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "CodexAccount_new" RENAME TO "CodexAccount"',
  )
}

async function rebuildChatTable(prisma) {
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "Chat_new"')
  await prisma.$executeRawUnsafe(createChatTable("Chat_new"))
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Chat_new" (
      "id",
      "accountId",
      "autoRotateAccount",
      "title",
      "workingDirectory",
      "model",
      "reasoningEffort",
      "serviceTier",
      "collaborationMode",
      "permissionMode",
      "status",
      "externalThreadId",
      "lastActivityAt",
      "createdAt",
      "updatedAt"
    )
    SELECT
      "id",
      "accountId",
      ${await selectColumnOrDefault(prisma, "Chat", "autoRotateAccount", "0")},
      "title",
      "workingDirectory",
      "model",
      "reasoningEffort",
      "serviceTier",
      "collaborationMode",
      "permissionMode",
      "status",
      "externalThreadId",
      "lastActivityAt",
      "createdAt",
      "updatedAt"
    FROM "Chat"
  `)
  await prisma.$executeRawUnsafe('DROP TABLE "Chat"')
  await prisma.$executeRawUnsafe('ALTER TABLE "Chat_new" RENAME TO "Chat"')
}

async function selectColumnOrNull(prisma, tableName, columnName) {
  return (await tableHasColumn(prisma, tableName, columnName))
    ? `"${columnName}"`
    : "NULL"
}

async function selectColumnOrDefault(prisma, tableName, columnName, fallback) {
  return (await tableHasColumn(prisma, tableName, columnName))
    ? `"${columnName}"`
    : fallback
}

function isDuplicateColumnError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.toLowerCase().includes("duplicate column name")
}

function workspaceDatabasePath() {
  return join(
    resolveHomePath(process.env.CODEX_WORKSPACE_ROOT?.trim() || homedir()),
    ".xedoc",
    "xedoc.db",
  )
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

function createCodexAccountTable(tableName) {
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "displayName" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
        "command" TEXT NOT NULL DEFAULT 'codex',
        "args" JSONB NOT NULL DEFAULT '["app-server"]',
        "environment" JSONB,
        "defaultModel" TEXT,
        "defaultPermissionMode" TEXT,
        "defaultReasoningEffort" TEXT,
        "defaultServiceTier" TEXT,
        "lastAuthUrl" TEXT,
        "lastAuthMode" TEXT,
        "lastAuthLoginId" TEXT,
        "lastAuthUserCode" TEXT,
        "lastError" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )`
}

function createChatTable(tableName) {
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "accountId" TEXT,
        "autoRotateAccount" BOOLEAN NOT NULL DEFAULT false,
        "title" TEXT NOT NULL,
        "workingDirectory" TEXT,
        "model" TEXT,
        "reasoningEffort" TEXT,
        "serviceTier" TEXT,
        "collaborationMode" TEXT NOT NULL DEFAULT 'default',
        "permissionMode" TEXT NOT NULL DEFAULT 'default',
        "status" TEXT NOT NULL DEFAULT 'IDLE',
        "externalThreadId" TEXT,
        "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "${tableName}_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CodexAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      )`
}

function createThreadPreferenceTable(tableName) {
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (
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
        CONSTRAINT "${tableName}_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CodexAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      )`
}

async function migrateLegacyChatPreferences(prisma) {
  try {
    await prisma.$executeRawUnsafe(`
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
    `)
  } catch {
    // Fresh installs or heavily customized old databases may not have legacy Chat rows.
  }
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS "ServerAuth" (
        "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'server',
        "passwordHash" TEXT NOT NULL,
        "tokenSecret" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )`,
  createCodexAccountTable("CodexAccount"),
  createChatTable("Chat"),
  createThreadPreferenceTable("ThreadPreference"),
  `CREATE TABLE IF NOT EXISTS "ChatMessage" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "chatId" TEXT NOT NULL,
        "runId" TEXT,
        "sequence" INTEGER NOT NULL,
        "role" TEXT NOT NULL,
        "kind" TEXT NOT NULL DEFAULT 'CHAT',
        "status" TEXT NOT NULL DEFAULT 'COMPLETED',
        "turnId" TEXT,
        "itemId" TEXT,
        "requestId" TEXT,
        "content" TEXT NOT NULL,
        "metadata" JSONB,
        "rawPayload" JSONB,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completedAt" DATETIME,
        CONSTRAINT "ChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "ChatMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ChatRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      )`,
  `CREATE TABLE IF NOT EXISTS "ChatRun" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "chatId" TEXT NOT NULL,
        "accountId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'QUEUED',
        "request" JSONB NOT NULL,
        "error" TEXT,
        "externalTurnId" TEXT,
        "interruptRequestedAt" DATETIME,
        "startedAt" DATETIME,
        "endedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "ChatRun_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "ChatRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CodexAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
      )`,
  'ALTER TABLE "CodexAccount" ADD COLUMN "defaultModel" TEXT',
  'ALTER TABLE "CodexAccount" ADD COLUMN "defaultPermissionMode" TEXT',
  'ALTER TABLE "CodexAccount" ADD COLUMN "defaultReasoningEffort" TEXT',
  'ALTER TABLE "CodexAccount" ADD COLUMN "defaultServiceTier" TEXT',
  'ALTER TABLE "CodexAccount" ADD COLUMN "lastAuthMode" TEXT',
  'ALTER TABLE "CodexAccount" ADD COLUMN "lastAuthLoginId" TEXT',
  'ALTER TABLE "CodexAccount" ADD COLUMN "lastAuthUserCode" TEXT',
  'ALTER TABLE "Chat" ADD COLUMN "autoRotateAccount" BOOLEAN NOT NULL DEFAULT false',
  'CREATE INDEX IF NOT EXISTS "Chat_updatedAt_idx" ON "Chat"("updatedAt")',
  'CREATE INDEX IF NOT EXISTS "Chat_lastActivityAt_idx" ON "Chat"("lastActivityAt")',
  'CREATE INDEX IF NOT EXISTS "Chat_accountId_idx" ON "Chat"("accountId")',
  'CREATE INDEX IF NOT EXISTS "ChatMessage_chatId_sequence_idx" ON "ChatMessage"("chatId", "sequence")',
  'CREATE INDEX IF NOT EXISTS "ChatMessage_chatId_turnId_idx" ON "ChatMessage"("chatId", "turnId")',
  'CREATE INDEX IF NOT EXISTS "ChatMessage_chatId_itemId_idx" ON "ChatMessage"("chatId", "itemId")',
  'CREATE INDEX IF NOT EXISTS "ChatMessage_requestId_idx" ON "ChatMessage"("requestId")',
  'CREATE INDEX IF NOT EXISTS "ChatMessage_runId_idx" ON "ChatMessage"("runId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_chatId_sequence_key" ON "ChatMessage"("chatId", "sequence")',
  'CREATE INDEX IF NOT EXISTS "ChatRun_chatId_createdAt_idx" ON "ChatRun"("chatId", "createdAt")',
  'CREATE INDEX IF NOT EXISTS "ChatRun_accountId_idx" ON "ChatRun"("accountId")',
  'CREATE INDEX IF NOT EXISTS "ChatRun_externalTurnId_idx" ON "ChatRun"("externalTurnId")',
  'CREATE INDEX IF NOT EXISTS "ThreadPreference_accountId_idx" ON "ThreadPreference"("accountId")',
  'CREATE INDEX IF NOT EXISTS "ThreadPreference_archivedAt_idx" ON "ThreadPreference"("archivedAt")',
]
