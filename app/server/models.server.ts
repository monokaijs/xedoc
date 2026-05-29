import type {
  AccountRateLimitsResponse,
  CodexModelListResponse,
  CodexRateLimitsResponse,
} from "@/types"
import {
  codexRuntimeService,
  isCodexAccountMarkedInvalidated,
  isCodexAuthTokenInvalidatedError,
  listCodexModelsForAccount,
  markCodexAccountInvalidated,
  readCodexRateLimitsForAccount,
} from "./codex-runtime.server"
import { normalizeEnvironment } from "./env.server"
import { HttpError } from "./http.server"
import { prisma } from "./prisma.server"

export async function listModels(accountId: string): Promise<CodexModelListResponse> {
  const account = await requireConnectedAccount(accountId)
  try {
    const response = await listCodexModelsForAccount(runtimeConfigForAccount(account))
    await requireNotInvalidated(accountId)
    return response
  } catch (error) {
    return handleCodexAccountDataError(accountId, error)
  }
}

export async function readRateLimits(
  accountId: string,
): Promise<CodexRateLimitsResponse> {
  const account = await requireConnectedAccount(accountId)
  try {
    const response = await readCodexRateLimitsForAccount(runtimeConfigForAccount(account))
    await requireNotInvalidated(accountId)
    return response
  } catch (error) {
    return handleCodexAccountDataError(accountId, error)
  }
}

export async function readConnectedAccountRateLimits(): Promise<AccountRateLimitsResponse> {
  const accounts = await prisma.codexAccount.findMany({
    orderBy: { createdAt: "asc" },
    where: { status: "CONNECTED" },
  })
  const results = await Promise.all(
    accounts.map(async (account): Promise<AccountRateLimitResult> => {
      try {
        return {
          accountId: account.id,
          response: await readRateLimits(account.id),
        }
      } catch (error) {
        return {
          accountId: account.id,
          error,
        }
      }
    }),
  )
  const data: AccountRateLimitsResponse["data"] = {}
  const errors: Record<string, string> = {}
  const invalidatedAccountIds: string[] = []

  for (const result of results) {
    if ("response" in result) {
      data[result.accountId] = result.response
      continue
    }
    const message =
      result.error instanceof Error
        ? result.error.message
        : "Unable to load rate limits."
    errors[result.accountId] = message
    if (result.error instanceof HttpError && result.error.status === 401) {
      invalidatedAccountIds.push(result.accountId)
    }
  }

  return {
    data,
    ...(Object.keys(errors).length ? { errors } : {}),
    ...(invalidatedAccountIds.length ? { invalidatedAccountIds } : {}),
  }
}

type AccountRateLimitResult =
  | {
      accountId: string
      response: CodexRateLimitsResponse
    }
  | {
      accountId: string
      error: unknown
    }

async function requireConnectedAccount(accountId: string) {
  const account = await prisma.codexAccount.findUnique({
    where: { id: accountId },
  })
  if (!account) {
    throw new HttpError(404, "Account not found.")
  }
  if (account.status !== "CONNECTED") {
    throw new HttpError(
      account.status === "INVALIDATED" ? 401 : 400,
      account.status === "INVALIDATED"
        ? "Codex authentication token was invalidated. Re-authenticate this account."
        : "Authenticate the account before loading Codex account data.",
    )
  }
  return account
}

async function requireNotInvalidated(accountId: string): Promise<void> {
  if (isCodexAccountMarkedInvalidated(accountId)) {
    throw new HttpError(
      401,
      "Codex authentication token was invalidated. Re-authenticate this account.",
    )
  }
  const account = await prisma.codexAccount.findUnique({
    select: { status: true },
    where: { id: accountId },
  })
  if (account?.status === "INVALIDATED") {
    throw new HttpError(
      401,
      "Codex authentication token was invalidated. Re-authenticate this account.",
    )
  }
}

async function handleCodexAccountDataError(
  accountId: string,
  error: unknown,
): Promise<never> {
  if (error instanceof HttpError) {
    throw error
  }
  if (isCodexAuthTokenInvalidatedError(error)) {
    await markCodexAccountInvalidated(accountId, error)
    codexRuntimeService.stopRuntime(accountId)
    throw new HttpError(
      401,
      "Codex authentication token was invalidated. Re-authenticate this account.",
    )
  }
  throw error
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
