import { Prisma, type CodexAccount } from "@prisma/client"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type {
  AccountAuthMode,
  AccountAuthExport,
  AuthenticateAccountResponse,
  CodexJsonRpcResponse,
  AccountExportDocument,
  AccountImportEntry,
  AccountPersonalizationResponse,
  AccountRuntimeSettingsRequest,
  AccountResponse,
  ImportAccountsRequest,
  ImportAccountsResponse,
  CreateAccountRequest,
  JsonObject,
  UpdateAccountPersonalizationRequest,
  UpdateAccountRequest,
} from "@/types"
import { normalizeEnvironment } from "./env.server"
import { HttpError } from "./http.server"
import { asJsonObject, readString } from "./json.server"
import {
  clearCodexAccountInvalidated,
  codexRuntimeService,
  ensureAccountCodexHome,
  resolveAccountCodexHome,
} from "./codex-runtime.server"
import { prisma } from "./prisma.server"

type RuntimeAccount = {
  id: string
  command: string
  args: unknown
  environment: unknown
}

type NormalizedImportAccount = Required<
  Pick<AccountImportEntry, "displayName" | "command" | "args">
> & {
  auth: AccountAuthExport | null
  defaultModel: string | null
  defaultPermissionMode: string | null
  defaultReasoningEffort: string | null
  defaultServiceTier: string | null
  environment: Record<string, string> | null
  id?: string
}

type LocalCodexAuthSnapshot = {
  authJson: JsonObject
  email: string | null
  fingerprint: string
}

const PERSONALIZATION_FILE_NAME = "AGENTS.md"
const PERSONALIZATION_MAX_BYTES = 32 * 1024
const ACCOUNT_AUTH_FILE_NAME = "auth.json"
const ACCOUNT_AUTH_MAX_BYTES = 256 * 1024

export async function createAccount(dto: CreateAccountRequest) {
  const account = await prisma.codexAccount.create({
    data: {
      displayName: normalizedInitialDisplayName(dto.displayName),
      command: dto.command ?? process.env.CODEX_COMMAND ?? "codex",
      args: toJsonInput(dto.args ?? parseDefaultCodexArgs()),
      defaultModel: normalizeNullableRuntimeOption(dto.defaultModel),
      defaultPermissionMode: normalizePermissionMode(dto.defaultPermissionMode),
      defaultReasoningEffort: normalizeReasoningEffort(dto.defaultReasoningEffort),
      defaultServiceTier: normalizeServiceTier(dto.defaultServiceTier),
      environment: toJsonInput(dto.environment),
    },
  })
  prepareAccountCodexHome(account.id)
  return account
}

export async function listAccounts() {
  const accounts = await prisma.codexAccount.findMany({
    orderBy: { createdAt: "asc" },
  })
  prepareAccountCodexHomes(accounts)
  return serializeAccountsWithLocalCodexActive(
    await reconcileAuthenticatingAccounts(accounts),
  )
}

async function reconcileAuthenticatingAccounts(accounts: CodexAccount[]) {
  return Promise.all(
    accounts.map(async (account) => {
      if (account.status !== "AUTHENTICATING" || !accountHasAuthFile(account.id)) {
        return account
      }
      codexRuntimeService.stopRuntime(account.id)
      return prisma.codexAccount.update({
        where: { id: account.id },
        data: connectedAccountAuthData(account.id),
      })
    }),
  )
}

export async function exportAccounts(): Promise<AccountExportDocument> {
  const accounts = await prisma.codexAccount.findMany({
    orderBy: { createdAt: "asc" },
  })

  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    accounts: accounts.map((account) => ({
      id: account.id,
      displayName: account.displayName,
      command: account.command,
      args: normalizeAccountArgs(account.args),
      auth: readAccountAuthExport(account.id),
      defaultModel: account.defaultModel,
      defaultPermissionMode:
        account.defaultPermissionMode as AccountResponse["defaultPermissionMode"],
      defaultReasoningEffort:
        account.defaultReasoningEffort as AccountResponse["defaultReasoningEffort"],
      defaultServiceTier:
        account.defaultServiceTier as AccountResponse["defaultServiceTier"],
      environment: normalizeEnvironment(account.environment),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    })),
  }
}

export async function importAccounts(
  dto: ImportAccountsRequest,
): Promise<ImportAccountsResponse> {
  const accounts = dto.accounts.map(normalizeImportAccount)
  const imported: CodexAccount[] = []

  for (const account of accounts) {
    const existing = account.id
      ? await prisma.codexAccount.findUnique({ where: { id: account.id } })
      : null

    if (existing) {
      codexRuntimeService.stopRuntime(existing.id)
      const importedAccount = await prisma.codexAccount.update({
        where: { id: existing.id },
        data: importedAccountData(account),
      })
      writeImportedAccountAuthFile(importedAccount.id, account.auth)
      imported.push(importedAccount)
      continue
    }

    const importedAccount = await prisma.codexAccount.create({
      data: {
        ...(account.id ? { id: account.id } : {}),
        ...importedAccountData(account),
      },
    })
    writeImportedAccountAuthFile(importedAccount.id, account.auth)
    imported.push(importedAccount)
  }

  if (!imported.length) {
    return { imported: 0, accounts: [], authentications: [] }
  }

  const authentications: AuthenticateAccountResponse[] = []
  for (const account of imported) {
    authentications.push(await authenticateAccount(account.id))
  }

  const refreshedAccounts = await prisma.codexAccount.findMany({
    where: { id: { in: imported.map((account) => account.id) } },
  })
  const refreshedById = new Map(
    refreshedAccounts.map((account) => [account.id, account]),
  )

  return {
    imported: imported.length,
    accounts: imported.map((account) =>
      serializeAccount(refreshedById.get(account.id) ?? account),
    ),
    authentications,
  }
}

export async function importLocalCodexActiveAccount(): Promise<ImportAccountsResponse> {
  const localAuth = readDefaultLocalCodexAuthSnapshot({ required: true })
  const existing = await findAccountMatchingLocalCodexAuth(localAuth)
  const account = existing
    ? await replaceAccountAuthWithLocalCodexAuth(existing, localAuth)
    : await createAccountFromLocalCodexAuth(localAuth)

  return {
    imported: 1,
    accounts: [serializeAccount(account, true)],
    authentications: [
      {
        accountId: account.id,
        status: "CONNECTED",
        authMode: null,
        authUrl: null,
        verificationUrl: null,
        userCode: null,
        message: "Imported the active local Codex account.",
      },
    ],
  }
}

export async function setLocalCodexActiveAccount(
  accountId: string,
): Promise<AccountResponse> {
  const account = await getAccount(accountId)
  const authJson = readRequiredAccountAuthFile(accountId)
  writeDefaultLocalCodexAuthFile(authJson)
  return serializeAccount(account, true)
}

export async function getAccount(accountId: string) {
  const account = await prisma.codexAccount.findUnique({
    where: { id: accountId },
  })
  if (!account) {
    throw new HttpError(404, "Codex account not found.")
  }
  prepareAccountCodexHome(account.id)
  return account
}

export async function updateAccount(
  accountId: string,
  dto: UpdateAccountRequest,
) {
  await getAccount(accountId)
  codexRuntimeService.stopRuntime(accountId)
  return prisma.codexAccount.update({
    where: { id: accountId },
    data: {
      displayName: dto.displayName,
      command: dto.command,
      args: dto.args === undefined ? undefined : toJsonInput(dto.args),
      environment: toJsonInput(dto.environment),
      status: "DISCONNECTED",
      lastAuthUrl: null,
      lastAuthMode: null,
      lastAuthLoginId: null,
      lastAuthUserCode: null,
      lastError: null,
    },
  })
}

export async function updateAccountRuntimeSettings(
  accountId: string,
  dto: AccountRuntimeSettingsRequest,
): Promise<AccountResponse> {
  await getAccount(accountId)
  return serializeAccount(
    await prisma.codexAccount.update({
      where: { id: accountId },
      data: {
        defaultModel:
          dto.defaultModel === undefined
            ? undefined
            : normalizeNullableRuntimeOption(dto.defaultModel),
        defaultPermissionMode:
          dto.defaultPermissionMode === undefined
            ? undefined
            : normalizePermissionMode(dto.defaultPermissionMode),
        defaultReasoningEffort:
          dto.defaultReasoningEffort === undefined
            ? undefined
            : normalizeReasoningEffort(dto.defaultReasoningEffort),
        defaultServiceTier:
          dto.defaultServiceTier === undefined
            ? undefined
            : normalizeServiceTier(dto.defaultServiceTier),
      },
    }),
  )
}

export async function getAccountPersonalization(
  accountId: string,
): Promise<AccountPersonalizationResponse> {
  await getAccount(accountId)
  const codexHome = ensureAccountCodexHome(accountId)
  const instructionsPath = join(codexHome, PERSONALIZATION_FILE_NAME)

  let instructions = ""
  try {
    instructions = readFileSync(instructionsPath, "utf8")
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }

  return {
    accountId,
    codexHome,
    instructionsPath,
    instructions,
    maxBytes: PERSONALIZATION_MAX_BYTES,
  }
}

export async function updateAccountPersonalization(
  accountId: string,
  dto: UpdateAccountPersonalizationRequest,
): Promise<AccountPersonalizationResponse> {
  const instructions = normalizePersonalizationInstructions(dto.instructions)
  await getAccount(accountId)
  const codexHome = ensureAccountCodexHome(accountId)
  const instructionsPath = join(codexHome, PERSONALIZATION_FILE_NAME)

  writeFileSync(instructionsPath, instructions, {
    encoding: "utf8",
    mode: 0o600,
  })
  chmodSync(instructionsPath, 0o600)

  return {
    accountId,
    codexHome,
    instructionsPath,
    instructions,
    maxBytes: PERSONALIZATION_MAX_BYTES,
  }
}

export async function deleteAccount(accountId: string) {
  const account = await getAccount(accountId)
  codexRuntimeService.stopRuntime(accountId)
  clearCodexAccountInvalidated(accountId)
  return prisma.$transaction(async (tx) => {
    await tx.chat.updateMany({
      where: { accountId },
      data: { accountId: null },
    })
    await tx.threadPreference.updateMany({
      where: { accountId },
      data: { accountId: null },
    })
    const runs = await tx.chatRun.findMany({
      select: { id: true },
      where: { accountId },
    })
    const runIds = runs.map((run) => run.id)
    if (runIds.length) {
      await tx.chatMessage.updateMany({
        where: { runId: { in: runIds } },
        data: { runId: null },
      })
      await tx.chatRun.deleteMany({
        where: { id: { in: runIds } },
      })
    }
    return tx.codexAccount.delete({ where: { id: account.id } })
  })
}

export async function authenticateAccount(
  accountId: string,
  mode: AccountAuthMode = "browser",
): Promise<AuthenticateAccountResponse> {
  const account = await getAccount(accountId)
  const authTokenInvalidated = account.status === "INVALIDATED"
  if (accountHasAuthFile(accountId) && !authTokenInvalidated) {
    codexRuntimeService.stopRuntime(accountId)
    await prisma.codexAccount.update({
      where: { id: accountId },
      data: connectedAccountAuthData(accountId),
    })
    return {
      accountId,
      status: "CONNECTED",
      authMode: null,
      authUrl: null,
      verificationUrl: null,
      userCode: null,
      message: "Codex account is connected.",
    }
  }
  if (authTokenInvalidated) {
    codexRuntimeService.stopRuntime(accountId)
    removeAccountAuthFile(accountId)
  }

  await prisma.codexAccount.update({
    where: { id: accountId },
    data: {
      status: "AUTHENTICATING",
      lastAuthUrl: null,
      lastAuthMode: mode,
      lastAuthLoginId: null,
      lastAuthUserCode: null,
      lastError: null,
    },
  })

  try {
    const runtime = getRuntime(account)
    if (!authTokenInvalidated) {
      const existingRuntimeAccount = await readExistingRuntimeAccount(runtime)
      if (existingRuntimeAccount) {
        await prisma.codexAccount.update({
          where: { id: accountId },
          data: connectedAccountAuthData(accountId, existingRuntimeAccount),
        })
        return {
          accountId,
          status: "CONNECTED",
          authMode: null,
          authUrl: null,
          verificationUrl: null,
          userCode: null,
          message: "Codex account is connected.",
        }
      }
    }

    const response = await runtime.request(
      "account/login/start",
      mode === "device"
        ? { type: "chatgptDeviceCode" }
        : { type: "chatgpt", codexStreamlinedLogin: true },
    )
    const result = asJsonObject(response.result)
    const responseMode =
      readString(result?.type) === "chatgptDeviceCode" ? "device" : mode
    const authUrl = readLoginAuthUrl(result, responseMode)
    const loginId = readString(result?.loginId) ?? null
    const userCode =
      responseMode === "device"
        ? readString(result?.userCode) ?? readString(result?.user_code) ?? null
        : null
    if (responseMode === "device" && (!authUrl || !userCode)) {
      throw new Error("Codex did not return device login instructions.")
    }
    const nextStatus = authUrl ? "AUTHENTICATING" : "CONNECTED"

    await prisma.codexAccount.update({
      where: { id: accountId },
      data:
        nextStatus === "CONNECTED"
          ? connectedAccountAuthData(accountId)
          : {
              status: nextStatus,
              lastAuthUrl: authUrl,
              lastAuthMode: responseMode,
              lastAuthLoginId: loginId,
              lastAuthUserCode: userCode,
              lastError: null,
            },
    })

    if (nextStatus === "AUTHENTICATING") {
      watchAuthenticationCompletion(runtime, accountId, loginId)
    }

    return {
      accountId,
      status: nextStatus,
      authMode: nextStatus === "AUTHENTICATING" ? responseMode : null,
      authUrl,
      verificationUrl: responseMode === "device" ? authUrl : null,
      userCode,
      loginId,
      message:
        nextStatus === "CONNECTED"
          ? "Codex account is connected."
          : responseMode === "device"
            ? "Open the verification URL and enter the device code to finish Codex authentication."
            : "Complete Codex authentication in the opened browser. xedoc will connect automatically when the Codex callback is received.",
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authentication failed."
    await prisma.codexAccount.update({
      where: { id: accountId },
      data: { status: "ERROR", lastError: message },
    })
    return {
      accountId,
      status: "ERROR",
      authMode: mode,
      authUrl: null,
      verificationUrl: null,
      userCode: null,
      message,
    }
  }
}

export async function cancelAuthentication(
  accountId: string,
): Promise<AccountResponse> {
  const account = await getAccount(accountId)
  cancelAuthenticationWatch(accountId)
  codexRuntimeService.stopRuntime(accountId)

  if (accountHasAuthFile(accountId)) {
    return serializeAccount(
      await prisma.codexAccount.update({
        where: { id: accountId },
        data: connectedAccountAuthData(accountId),
      }),
      localCodexActiveAccountIds([account]).has(accountId),
    )
  }

  if (account.status !== "AUTHENTICATING") {
    return serializeAccount(account, localCodexActiveAccountIds([account]).has(accountId))
  }

  return serializeAccount(
    await prisma.codexAccount.update({
      where: { id: accountId },
      data: {
        status: "DISCONNECTED",
        lastAuthUrl: null,
        lastAuthMode: null,
        lastAuthLoginId: null,
        lastAuthUserCode: null,
        lastError: null,
      },
    }),
  )
}

export async function completeAuthentication(
  accountId: string,
  redirectUrl: string,
): Promise<AuthenticateAccountResponse> {
  const account = await getAccount(accountId)
  const callbackUrl = parseLoopbackCallbackUrl(redirectUrl)
  const runtime = getRuntime(account)
  const completedEventPromise = runtime
    .waitForEvent(
      (event) =>
        event.method === "account/login/completed" ||
        event.method === "account/updated",
      15_000,
    )
    .catch(() => null)

  try {
    const response = await fetchLoopbackCallback(callbackUrl)
    if (response.status >= 400) {
      const preview = await readResponsePreview(response)
      throw new HttpError(
        400,
        [`Codex login callback returned HTTP ${response.status}.`, preview]
          .filter(Boolean)
          .join("\n"),
      )
    }

    const completedEvent = await completedEventPromise
    const completion = asJsonObject(completedEvent?.params)
    if (completion?.success === false) {
      const message = readString(completion.error) ?? "Login failed."
      await prisma.codexAccount.update({
        where: { id: accountId },
        data: { status: "ERROR", lastError: message },
      })
      return {
        accountId,
        status: "ERROR",
        authMode: normalizeStoredAuthMode(account.lastAuthMode),
        authUrl: null,
        verificationUrl:
          account.lastAuthMode === "device" ? account.lastAuthUrl : null,
        userCode: account.lastAuthUserCode,
        message,
      }
    }

    const connected = await readAccountConnected(account.id, runtime)
    if (connected) {
      return {
        accountId,
        status: "CONNECTED",
        authMode: null,
        authUrl: null,
        verificationUrl: null,
        userCode: null,
        message: "Codex account is connected.",
      }
    }

    if (accountHasAuthFile(accountId)) {
      codexRuntimeService.stopRuntime(accountId)
      await prisma.codexAccount.update({
        where: { id: accountId },
        data: connectedAccountAuthData(accountId),
      })
      return {
        accountId,
        status: "CONNECTED",
        authMode: null,
        authUrl: null,
        verificationUrl: null,
        userCode: null,
        message: "Codex account is connected.",
      }
    }

    await prisma.codexAccount.update({
      where: { id: accountId },
      data: {
        status: "AUTHENTICATING",
        lastError: null,
      },
    })
    return {
      accountId,
      status: "AUTHENTICATING",
      authMode: normalizeStoredAuthMode(account.lastAuthMode),
      authUrl: account.lastAuthUrl,
      verificationUrl:
        account.lastAuthMode === "device" ? account.lastAuthUrl : null,
      userCode: account.lastAuthUserCode,
      message: "Callback accepted. Codex is still finishing authentication.",
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authentication failed."
    await prisma.codexAccount.update({
      where: { id: accountId },
      data: { status: "ERROR", lastError: message },
    })
    return {
      accountId,
      status: "ERROR",
      authMode: normalizeStoredAuthMode(account.lastAuthMode),
      authUrl: account.lastAuthUrl,
      verificationUrl:
        account.lastAuthMode === "device" ? account.lastAuthUrl : null,
      userCode: account.lastAuthUserCode,
      message,
    }
  }
}

function watchAuthenticationCompletion(
  runtime: ReturnType<typeof getRuntime>,
  accountId: string,
  loginId: string | null,
) {
  cancelAuthenticationWatch(accountId)
  let settled = false
  let unsubscribe = () => {}
  const finish = () => {
    if (settled) {
      return
    }
    settled = true
    cleanup()
    void prisma.codexAccount.update({
      where: { id: accountId },
      data: connectedAccountAuthData(accountId),
    })
  }
  const fail = (message: string) => {
    if (settled) {
      return
    }
    settled = true
    cleanup()
    void prisma.codexAccount.update({
      where: { id: accountId },
      data: {
        status: "ERROR",
        lastError: message,
      },
    })
  }
  const poll = setInterval(() => {
    if (accountHasAuthFile(accountId)) {
      finish()
      return
    }
    void readAccountConnected(accountId, runtime)
      .then((connected) => {
        if (connected) {
          settled = true
          cleanup()
        }
      })
      .catch(() => {})
  }, 1500)
  const timeout = setTimeout(() => {
    cleanup()
  }, 5 * 60_000)
  const cleanup = () => {
    clearInterval(poll)
    clearTimeout(timeout)
    unsubscribe()
    if (authenticationWatchCleanups.get(accountId) === cleanup) {
      authenticationWatchCleanups.delete(accountId)
    }
  }

  authenticationWatchCleanups.set(accountId, cleanup)

  unsubscribe = runtime.onEvent((event) => {
    const params = asJsonObject(event.params)
    if (event.method === "account/login/completed") {
      const eventLoginId = readString(params?.loginId)
      if (loginId && eventLoginId && eventLoginId !== loginId) {
        return
      }
      if (params?.success === false) {
        fail(readString(params.error) ?? "Login failed.")
        return
      }
      finish()
      return
    }
    if (event.method === "account/updated" && readString(params?.authMode)) {
      finish()
    }
  })
}

const authenticationWatchCleanups = new Map<string, () => void>()

function cancelAuthenticationWatch(accountId: string): void {
  authenticationWatchCleanups.get(accountId)?.()
  authenticationWatchCleanups.delete(accountId)
}

function connectedAccountAuthData(
  accountId: string,
  runtimeAccount?: JsonObject,
) {
  clearCodexAccountInvalidated(accountId)
  const displayName =
    readRuntimeAccountEmail(runtimeAccount) ?? readAccountAuthEmail(accountId)
  return {
    ...(displayName ? { displayName } : {}),
    status: "CONNECTED" as const,
    lastAuthUrl: null,
    lastAuthMode: null,
    lastAuthLoginId: null,
    lastAuthUserCode: null,
    lastError: null,
  }
}

function readLoginAuthUrl(
  result: JsonObject | undefined,
  mode: AccountAuthMode,
): string | null {
  if (mode === "device") {
    return (
      readString(result?.verificationUrl) ??
      readString(result?.verification_url) ??
      readString(result?.authUrl) ??
      readString(result?.auth_url) ??
      readString(result?.url) ??
      null
    )
  }

  return (
    readString(result?.authUrl) ??
    readString(result?.auth_url) ??
    readString(result?.url) ??
    null
  )
}

function normalizeStoredAuthMode(value: unknown): AccountAuthMode | null {
  return value === "browser" || value === "device" ? value : null
}

function getRuntime(account: RuntimeAccount) {
  return codexRuntimeService.getRuntime({
    accountId: account.id,
    command: account.command,
    args: normalizeAccountArgs(account.args),
    workingDirectory: null,
    environment: normalizeEnvironment(account.environment),
  })
}

async function readExistingRuntimeAccount(runtime: {
  request(
    method: string,
    params: JsonObject,
    timeoutMs?: number,
  ): Promise<CodexJsonRpcResponse>
}): Promise<JsonObject | null> {
  try {
    const response = await runtime.request("account/read", {
      refreshToken: false,
    })
    return asJsonObject(asJsonObject(response.result)?.account) ?? null
  } catch {
    return null
  }
}

async function readAccountConnected(
  accountId: string,
  runtime: {
    request(
      method: string,
      params: JsonObject,
      timeoutMs?: number,
    ): Promise<CodexJsonRpcResponse>
  },
): Promise<boolean> {
  const response = await runtime.request("account/read", {
    refreshToken: false,
  })
  const runtimeAccount = asJsonObject(asJsonObject(response.result)?.account)
  if (!runtimeAccount) {
    return false
  }
  await prisma.codexAccount.update({
    where: { id: accountId },
    data: connectedAccountAuthData(accountId, runtimeAccount),
  })
  return true
}

function normalizedInitialDisplayName(value: unknown): string {
  return readString(value)?.trim() || "Codex account"
}

function parseDefaultCodexArgs(): string[] {
  const raw = process.env.CODEX_ARGS
  if (!raw) {
    return ["app-server"]
  }
  return raw
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
}

export function accountHasAuthFile(accountId: string): boolean {
  try {
    const auth = readAccountAuthFile(accountId)
    return isUsableCodexAuth(auth)
  } catch {
    return false
  }
}

function isUsableCodexAuth(auth: JsonObject): boolean {
  return (
    readString(auth.auth_mode) === "chatgpt" &&
    (!!asJsonObject(auth.tokens) || !!readString(auth.OPENAI_API_KEY))
  )
}

function readRequiredAccountAuthFile(accountId: string): JsonObject {
  try {
    const auth = readAccountAuthFile(accountId)
    if (!isUsableCodexAuth(auth)) {
      throw new HttpError(
        409,
        "Authenticate this xedoc account before making it the active local Codex account.",
      )
    }
    return auth
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }
    throw new HttpError(
      409,
      "Authenticate this xedoc account before making it the active local Codex account.",
    )
  }
}

function readAccountAuthEmail(accountId: string): string | null {
  try {
    const auth = readAccountAuthFile(accountId)
    return readAccountEmailFromAuth(auth)
  } catch {
    return null
  }
}

function readAccountAuthFile(accountId: string): JsonObject {
  const raw = readFileSync(
    join(resolveAccountCodexHome(accountId), ACCOUNT_AUTH_FILE_NAME),
    "utf8",
  )
  return asJsonObject(JSON.parse(raw)) ?? {}
}

function removeAccountAuthFile(accountId: string): void {
  rmSync(join(resolveAccountCodexHome(accountId), ACCOUNT_AUTH_FILE_NAME), {
    force: true,
  })
}

function readAccountAuthExport(accountId: string): AccountAuthExport | null {
  try {
    const authJson = readAccountAuthFile(accountId)
    if (!Object.keys(authJson).length) {
      return null
    }
    return { authJson }
  } catch {
    return null
  }
}

function writeImportedAccountAuthFile(
  accountId: string,
  auth: AccountAuthExport | null,
): void {
  if (!auth) {
    return
  }

  const codexHome = ensureAccountCodexHome(accountId)
  const content = `${JSON.stringify(auth.authJson)}\n`
  writeFileSync(join(codexHome, ACCOUNT_AUTH_FILE_NAME), content, {
    encoding: "utf8",
    mode: 0o600,
  })
  chmodSync(join(codexHome, ACCOUNT_AUTH_FILE_NAME), 0o600)
}

function writeDefaultLocalCodexAuthFile(authJson: JsonObject): void {
  const codexHome = resolveDefaultLocalCodexHome()
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  chmodSync(codexHome, 0o700)
  const authPath = join(codexHome, ACCOUNT_AUTH_FILE_NAME)
  writeFileSync(authPath, `${JSON.stringify(authJson)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  chmodSync(authPath, 0o600)
}

function serializeAccountsWithLocalCodexActive(
  accounts: CodexAccount[],
): AccountResponse[] {
  const activeIds = localCodexActiveAccountIds(accounts)
  return accounts.map((account) =>
    serializeAccount(account, activeIds.has(account.id)),
  )
}

function localCodexActiveAccountIds(accounts: CodexAccount[]): Set<string> {
  const localAuth = readDefaultLocalCodexAuthSnapshot({ required: false })
  if (!localAuth) {
    return new Set()
  }

  const accountAuths = accounts.flatMap((account) => {
    const auth = readAccountAuthSnapshot(account.id)
    return auth ? [{ account, auth }] : []
  })
  const exactMatches = accountAuths.filter(
    (entry) => entry.auth.fingerprint === localAuth.fingerprint,
  )
  if (exactMatches.length) {
    return new Set(exactMatches.map((entry) => entry.account.id))
  }

  if (!localAuth.email) {
    return new Set()
  }
  return new Set(
    accountAuths
      .filter((entry) => entry.auth.email === localAuth.email)
      .map((entry) => entry.account.id),
  )
}

async function findAccountMatchingLocalCodexAuth(
  localAuth: LocalCodexAuthSnapshot,
): Promise<CodexAccount | null> {
  const accounts = await prisma.codexAccount.findMany({
    orderBy: { createdAt: "asc" },
  })
  const accountAuths = accounts.flatMap((account) => {
    const auth = readAccountAuthSnapshot(account.id)
    return auth ? [{ account, auth }] : []
  })
  const exactMatch = accountAuths.find(
    (entry) => entry.auth.fingerprint === localAuth.fingerprint,
  )
  if (exactMatch) {
    return exactMatch.account
  }
  if (!localAuth.email) {
    return null
  }
  const emailMatches = accountAuths.filter(
    (entry) => entry.auth.email === localAuth.email,
  )
  return emailMatches.length === 1 ? emailMatches[0].account : null
}

async function replaceAccountAuthWithLocalCodexAuth(
  account: CodexAccount,
  localAuth: LocalCodexAuthSnapshot,
): Promise<CodexAccount> {
  codexRuntimeService.stopRuntime(account.id)
  writeImportedAccountAuthFile(account.id, { authJson: localAuth.authJson })
  return prisma.codexAccount.update({
    where: { id: account.id },
    data: connectedAccountAuthData(account.id),
  })
}

async function createAccountFromLocalCodexAuth(
  localAuth: LocalCodexAuthSnapshot,
): Promise<CodexAccount> {
  const account = await prisma.codexAccount.create({
    data: {
      displayName: localAuth.email ?? "Local Codex account",
      command: process.env.CODEX_COMMAND ?? "codex",
      args: toJsonInput(parseDefaultCodexArgs()),
      environment: toJsonInput(undefined),
    },
  })
  writeImportedAccountAuthFile(account.id, { authJson: localAuth.authJson })
  return prisma.codexAccount.update({
    where: { id: account.id },
    data: connectedAccountAuthData(account.id),
  })
}

function readDefaultLocalCodexAuthSnapshot(options: {
  required: true
}): LocalCodexAuthSnapshot
function readDefaultLocalCodexAuthSnapshot(options: {
  required: false
}): LocalCodexAuthSnapshot | null
function readDefaultLocalCodexAuthSnapshot(options: {
  required: boolean
}): LocalCodexAuthSnapshot | null {
  try {
    const authPath = join(resolveDefaultLocalCodexHome(), ACCOUNT_AUTH_FILE_NAME)
    const raw = readFileSync(authPath, "utf8")
    if (Buffer.byteLength(raw, "utf8") > ACCOUNT_AUTH_MAX_BYTES) {
      throw new HttpError(
        400,
        `Local Codex auth.json must be ${ACCOUNT_AUTH_MAX_BYTES} bytes or fewer.`,
      )
    }
    const authJson = asJsonObject(JSON.parse(raw))
    if (!authJson || !isUsableCodexAuth(authJson)) {
      throw new HttpError(
        400,
        "Local Codex auth.json does not contain an active ChatGPT account.",
      )
    }
    return authSnapshotFromJson(authJson)
  } catch (error) {
    if (!options.required) {
      return null
    }
    if (error instanceof HttpError) {
      throw error
    }
    throw new HttpError(
      404,
      "No active local Codex auth.json was found. Sign in with the local Codex CLI first.",
    )
  }
}

function readAccountAuthSnapshot(accountId: string): LocalCodexAuthSnapshot | null {
  try {
    const authJson = readAccountAuthFile(accountId)
    if (!isUsableCodexAuth(authJson)) {
      return null
    }
    return authSnapshotFromJson(authJson)
  } catch {
    return null
  }
}

function authSnapshotFromJson(authJson: JsonObject): LocalCodexAuthSnapshot {
  return {
    authJson,
    email: readAccountEmailFromAuth(authJson),
    fingerprint: fingerprintJson(authJson),
  }
}

function fingerprintJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function resolveDefaultLocalCodexHome(): string {
  return resolveHomePath(
    process.env.CODEX_LOCAL_HOME?.trim() ||
      process.env.CODEX_HOME?.trim() ||
      "~/.codex",
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

function readAccountEmailFromAuth(auth: JsonObject): string | null {
  return (
    normalizeEmail(readString(auth.email)) ??
    normalizeEmail(readString(asJsonObject(auth.account)?.email)) ??
    normalizeEmail(readString(asJsonObject(auth.profile)?.email)) ??
    normalizeEmail(readString(asJsonObject(auth.user)?.email)) ??
    readEmailFromToken(readString(asJsonObject(auth.tokens)?.id_token)) ??
    readEmailFromToken(readString(asJsonObject(auth.tokens)?.idToken)) ??
    readEmailFromToken(readString(auth.id_token)) ??
    readEmailFromToken(readString(auth.idToken))
  )
}

function readRuntimeAccountEmail(account: JsonObject | undefined): string | null {
  if (!account) {
    return null
  }
  return (
    normalizeEmail(readString(account.email)) ??
    normalizeEmail(readString(account.accountEmail)) ??
    normalizeEmail(readString(account.chatgptEmail)) ??
    normalizeEmail(readString(asJsonObject(account.profile)?.email)) ??
    normalizeEmail(readString(asJsonObject(account.user)?.email))
  )
}

function readEmailFromToken(token: string | undefined): string | null {
  if (!token) {
    return null
  }
  const [, payload] = token.split(".")
  if (!payload) {
    return null
  }
  try {
    const decoded = JSON.parse(decodeBase64Url(payload)) as unknown
    return normalizeEmail(readString(asJsonObject(decoded)?.email))
  } catch {
    return null
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  )
  return Buffer.from(padded, "base64").toString("utf8")
}

function normalizeEmail(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || !trimmed.includes("@")) {
    return null
  }
  return trimmed
}

function prepareAccountCodexHomes(accounts: Pick<CodexAccount, "id">[]) {
  for (const account of accounts) {
    prepareAccountCodexHome(account.id)
  }
}

function prepareAccountCodexHome(accountId: string): void {
  try {
    ensureAccountCodexHome(accountId)
  } catch (error) {
    console.warn(
      `Failed to prepare Codex account home for ${accountId}.`,
      error instanceof Error ? error.message : error,
    )
  }
}

function normalizePersonalizationInstructions(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "instructions must be a string.")
  }
  const normalized = value.replace(/\r\n?/g, "\n")
  if (Buffer.byteLength(normalized, "utf8") > PERSONALIZATION_MAX_BYTES) {
    throw new HttpError(
      400,
      `instructions must be ${PERSONALIZATION_MAX_BYTES} bytes or fewer.`,
    )
  }
  return normalized
}

function isMissingFileError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}

function parseLoopbackCallbackUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new HttpError(400, "Paste a valid callback URL.")
  }
  if (url.protocol !== "http:") {
    throw new HttpError(400, "Callback URL must use http.")
  }
  if (url.username || url.password) {
    throw new HttpError(400, "Callback URL must not include credentials.")
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new HttpError(400, "Callback URL must point to localhost.")
  }
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
    throw new HttpError(400, "Callback URL must include an OAuth code or error.")
  }
  return url
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === "localhost" || normalized === "::1") {
    return true
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

async function fetchLoopbackCallback(url: URL): Promise<Response> {
  try {
    return await fetch(url, { redirect: "manual" })
  } catch (error) {
    if (url.hostname !== "localhost") {
      throw error
    }
    const ipv4Url = new URL(url.toString())
    ipv4Url.hostname = "127.0.0.1"
    return fetch(ipv4Url, { redirect: "manual" })
  }
}

async function readResponsePreview(response: Response): Promise<string | null> {
  const text = await response.text()
  const trimmed = text.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function toNullableJsonInput(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) {
    return Prisma.JsonNull
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function importedAccountData(account: NormalizedImportAccount) {
  return {
    args: toJsonInput(account.args),
    command: account.command,
    defaultModel: account.defaultModel,
    defaultPermissionMode: account.defaultPermissionMode,
    defaultReasoningEffort: account.defaultReasoningEffort,
    defaultServiceTier: account.defaultServiceTier,
    displayName: account.displayName,
    environment: toNullableJsonInput(account.environment),
    lastAuthUrl: null,
    lastAuthMode: null,
    lastAuthLoginId: null,
    lastAuthUserCode: null,
    lastError: null,
    status: "DISCONNECTED" as const,
  }
}

function serializeAccount(
  account: CodexAccount,
  isLocalCodexActive = false,
): AccountResponse {
  return {
    id: account.id,
    displayName: account.displayName,
    status: account.status,
    isLocalCodexActive,
    command: account.command,
    args: normalizeAccountArgs(account.args),
    environment: normalizeEnvironment(account.environment),
    defaultModel: account.defaultModel,
    defaultPermissionMode:
      account.defaultPermissionMode as AccountResponse["defaultPermissionMode"],
    defaultReasoningEffort:
      account.defaultReasoningEffort as AccountResponse["defaultReasoningEffort"],
    defaultServiceTier:
      account.defaultServiceTier as AccountResponse["defaultServiceTier"],
    lastAuthUrl: account.lastAuthUrl,
    lastAuthMode: normalizeStoredAuthMode(account.lastAuthMode),
    lastAuthLoginId: account.lastAuthLoginId,
    lastAuthUserCode: account.lastAuthUserCode,
    lastError: account.lastError,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }
}

function normalizeAccountArgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return parseDefaultCodexArgs()
  }
  return value.filter((entry): entry is string => typeof entry === "string")
}

function normalizeImportAccount(
  value: AccountImportEntry,
  index: number,
): NormalizedImportAccount {
  const fieldPrefix = `accounts[${index}]`
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${fieldPrefix} must be an object.`)
  }

  return {
    id: normalizeOptionalString(value.id, `${fieldPrefix}.id`, 128),
    displayName: normalizeRequiredString(
      value.displayName,
      `${fieldPrefix}.displayName`,
      128,
    ),
    command:
      normalizeOptionalString(value.command, `${fieldPrefix}.command`, 256) ??
      process.env.CODEX_COMMAND ??
      "codex",
    args: normalizeOptionalStringArray(value.args, `${fieldPrefix}.args`) ??
      parseDefaultCodexArgs(),
    auth: normalizeImportAuth(value.auth, `${fieldPrefix}.auth`),
    defaultModel:
      normalizeOptionalString(value.defaultModel, `${fieldPrefix}.defaultModel`, 128) ??
      null,
    defaultPermissionMode:
      normalizePermissionMode(
        value.defaultPermissionMode,
        `${fieldPrefix}.defaultPermissionMode`,
      ) ?? null,
    defaultReasoningEffort:
      normalizeReasoningEffort(
        value.defaultReasoningEffort,
        `${fieldPrefix}.defaultReasoningEffort`,
      ) ?? null,
    defaultServiceTier:
      normalizeServiceTier(
        value.defaultServiceTier,
        `${fieldPrefix}.defaultServiceTier`,
      ) ?? null,
    environment: normalizeImportEnvironment(
      value.environment,
      `${fieldPrefix}.environment`,
    ),
  }
}

function normalizeNullableRuntimeOption(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return normalizeRequiredString(value, "runtime option", 128)
}

function normalizeReasoningEffort(
  value: unknown,
  field = "defaultReasoningEffort",
): AccountResponse["defaultReasoningEffort"] {
  if (value === null || value === undefined) {
    return null
  }
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value
  }
  throw new HttpError(400, `${field} is invalid.`)
}

function normalizeServiceTier(
  value: unknown,
  field = "defaultServiceTier",
): AccountResponse["defaultServiceTier"] {
  if (value === null || value === undefined) {
    return null
  }
  if (value === "fast" || value === "flex") {
    return value
  }
  throw new HttpError(400, `${field} is invalid.`)
}

function normalizePermissionMode(
  value: unknown,
  field = "defaultPermissionMode",
): AccountResponse["defaultPermissionMode"] {
  if (value === null || value === undefined) {
    return null
  }
  if (value === "default" || value === "fullAccess") {
    return value
  }
  throw new HttpError(400, `${field} is invalid.`)
}

function normalizeRequiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const normalized = normalizeOptionalString(value, field, maxLength)
  if (!normalized) {
    throw new HttpError(400, `${field} is required.`)
  }
  return normalized
}

function normalizeOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string.`)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new HttpError(400, `${field} must be ${maxLength} characters or fewer.`)
  }
  return normalized || undefined
}

function normalizeOptionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HttpError(400, `${field} must be an array of strings.`)
  }
  return value
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function normalizeImportAuth(
  value: unknown,
  field: string,
): AccountAuthExport | null {
  if (value === undefined || value === null) {
    return null
  }
  const object = asJsonObject(value)
  if (!object) {
    throw new HttpError(400, `${field} must be an object.`)
  }
  const authJson = asJsonObject(object.authJson)
  if (!authJson) {
    throw new HttpError(400, `${field}.authJson must be an object.`)
  }
  validateJsonByteSize(authJson, `${field}.authJson`, ACCOUNT_AUTH_MAX_BYTES)
  return { authJson }
}

function normalizeImportEnvironment(
  value: unknown,
  field: string,
): Record<string, string> | null {
  if (value === undefined || value === null) {
    return null
  }
  const object = asJsonObject(value)
  if (!object) {
    throw new HttpError(400, `${field} must be an object.`)
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, String(entry)]),
  )
}

function validateJsonByteSize(
  value: unknown,
  field: string,
  maxBytes: number,
): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
    throw new HttpError(400, `${field} must be ${maxBytes} bytes or fewer.`)
  }
}
