import type { CodexModelListResponse, CodexRateLimitsResponse } from "@/types"
import {
  listCodexModelsForAccount,
  readCodexRateLimitsForAccount,
} from "./codex-runtime.server"
import { normalizeEnvironment } from "./env.server"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"

export async function listModels(accountId: string): Promise<CodexModelListResponse> {
  const account = await requireConnectedAccount(accountId)
  return listCodexModelsForAccount(runtimeConfigForAccount(account))
}

export async function readRateLimits(
  accountId: string,
): Promise<CodexRateLimitsResponse> {
  const account = await requireConnectedAccount(accountId)
  return readCodexRateLimitsForAccount(runtimeConfigForAccount(account))
}

async function requireConnectedAccount(accountId: string) {
  const account = await prisma.codexAccount.findUnique({
    where: { id: accountId },
  })
  if (!account) {
    throw new HttpError(404, "Account not found.")
  }
  if (account.status !== "CONNECTED") {
    throw new HttpError(400, "Authenticate the account before loading Codex account data.")
  }
  return account
}

function runtimeConfigForAccount(account: Awaited<ReturnType<typeof requireConnectedAccount>>) {
  return {
    accountId: account.id,
    args: normalizeAccountArgs(account.args),
    command: account.command,
    environment: normalizeEnvironment(account.environment),
    workingDirectory: null,
  }
}

function normalizeAccountArgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ["app-server"]
  }
  return value.filter((entry): entry is string => typeof entry === "string")
}
