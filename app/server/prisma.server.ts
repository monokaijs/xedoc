import "dotenv/config"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient
}

const databasePath = workspaceDatabasePath()
const databaseUrl = sqliteDatabaseUrl(databasePath)
process.env.DATABASE_URL = databaseUrl
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}

function workspaceDatabasePath(): string {
  return join(
    resolveHomePath(process.env.CODEX_WORKSPACE_ROOT?.trim() || homedir()),
    ".xedoc",
    "xedoc.db",
  )
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

function sqliteDatabaseUrl(path: string): string {
  return `file:${path}?connection_limit=1&pool_timeout=30`
}
