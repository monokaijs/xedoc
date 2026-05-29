import type {
  AccountResponse,
  AccountRateLimitsResponse,
  AccountRuntimeSettingsRequest,
  AccountExportDocument,
  AuthenticateAccountRequest,
  AuthenticateAccountResponse,
  ChatMessageResponse,
  ChatResponse,
  CompleteAccountLoginRequest,
  CreateAccountRequest,
  CreateChatRequest,
  CodexModelListResponse,
  CodexRateLimitsResponse,
  CreateWorkspaceDirectoryRequest,
  CreateWorkflowTaskRequest,
  ExecuteChatRequest,
  ExecuteChatResponse,
  ImportAccountsRequest,
  ImportAccountsResponse,
  InterruptChatRunResponse,
  LoginCallbackPortStatus,
  MessagePageResponse,
  ServerRequestResponseRequest,
  AuthExchangeRequest,
  AuthExchangeResponse,
  AuthSessionResponse,
  AuthStatusResponse,
  ChatContextResponse,
  UpdateAccountRequest,
  UpdateChatRequest,
  UpdateWorkflowTaskRequest,
  GitActionRequest,
  GitActionResponse,
  GitBranchesResponse,
  GitDiffResponse,
  GitHistoryResponse,
  GitStatusResponse,
  WorkspaceDirectoryResponse,
  WorkspaceFileResponse,
  WorkflowTaskResponse,
} from "@/types"

export interface ApiSession {
  serverUrl: string
  token: string
}

export class ApiError extends Error {
  readonly status: number
  readonly url: string

  constructor(
    message: string,
    status: number,
    url: string,
  ) {
    super(message)
    this.status = status
    this.url = url
  }
}

export class ApiNetworkError extends Error {
  readonly request: {
    method: string
    url: string
  }

  constructor(
    request: {
      method: string
      url: string
    },
    originalError: unknown,
  ) {
    super(formatNetworkError(request, originalError))
    this.request = request
  }
}

export async function getAuthStatus(
  serverUrl: string,
): Promise<AuthStatusResponse> {
  return fetchJson<AuthStatusResponse>(serverUrl, "/api/auth/status", {
    token: null,
  })
}

export async function exchangePassword(
  serverUrl: string,
  password: string,
): Promise<AuthExchangeResponse> {
  return fetchJson<AuthExchangeResponse>(
    serverUrl,
    "/api/auth/exchange",
    {
      body: { password } satisfies AuthExchangeRequest,
      token: null,
    },
  )
}

export async function getSessionStatus(
  session: ApiSession,
): Promise<AuthSessionResponse> {
  return fetchJson<AuthSessionResponse>(
    session.serverUrl,
    "/api/auth/session",
    { token: session.token },
  )
}

export async function listAccounts(
  session: ApiSession,
): Promise<AccountResponse[]> {
  return fetchJson<AccountResponse[]>(
    session.serverUrl,
    "/api/accounts",
    { token: session.token },
  )
}

export async function exportAccounts(
  session: ApiSession,
): Promise<AccountExportDocument> {
  return fetchJson<AccountExportDocument>(
    session.serverUrl,
    "/api/accounts/export",
    { token: session.token },
  )
}

export async function importAccounts(
  session: ApiSession,
  body: ImportAccountsRequest,
): Promise<ImportAccountsResponse> {
  return fetchJson<ImportAccountsResponse>(
    session.serverUrl,
    "/api/accounts/import",
    { body, token: session.token },
  )
}

export async function importLocalCodexActiveAccount(
  session: ApiSession,
): Promise<ImportAccountsResponse> {
  return fetchJson<ImportAccountsResponse>(
    session.serverUrl,
    "/api/accounts/import-local-active",
    { body: {}, token: session.token },
  )
}

export async function readLoginCallbackPortStatus(
  session: ApiSession,
): Promise<LoginCallbackPortStatus> {
  return fetchJson<LoginCallbackPortStatus>(
    session.serverUrl,
    "/api/accounts/login-callback-port",
    { token: session.token },
  )
}

export async function killLoginCallbackPortProcess(
  session: ApiSession,
): Promise<LoginCallbackPortStatus> {
  return fetchJson<LoginCallbackPortStatus>(
    session.serverUrl,
    "/api/accounts/login-callback-port",
    { body: {}, token: session.token },
  )
}

export async function getAccount(
  session: ApiSession,
  accountId: string,
): Promise<AccountResponse> {
  return fetchJson<AccountResponse>(session.serverUrl, `/api/accounts/${accountId}`, {
    token: session.token,
  })
}

export async function createAccount(
  session: ApiSession,
  body: CreateAccountRequest,
): Promise<AccountResponse> {
  return fetchJson<AccountResponse>(session.serverUrl, "/api/accounts", {
    body,
    token: session.token,
  })
}

export async function updateAccount(
  session: ApiSession,
  accountId: string,
  body: UpdateAccountRequest,
): Promise<AccountResponse> {
  return fetchJson<AccountResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}`,
    {
      body,
      method: "PATCH",
      token: session.token,
    },
  )
}

export async function updateAccountRuntimeSettings(
  session: ApiSession,
  accountId: string,
  body: AccountRuntimeSettingsRequest,
): Promise<AccountResponse> {
  return fetchJson<AccountResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}/runtime-settings`,
    {
      body,
      method: "PATCH",
      token: session.token,
    },
  )
}

export async function deleteAccount(
  session: ApiSession,
  accountId: string,
): Promise<AccountResponse> {
  return fetchJson<AccountResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}`,
    {
      method: "DELETE",
      token: session.token,
    },
  )
}

export async function setLocalCodexActiveAccount(
  session: ApiSession,
  accountId: string,
): Promise<AccountResponse> {
  return fetchJson<AccountResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}/local-active`,
    { body: {}, token: session.token },
  )
}

export async function authenticateAccount(
  session: ApiSession,
  accountId: string,
  body: AuthenticateAccountRequest = {},
): Promise<AuthenticateAccountResponse> {
  return fetchJson<AuthenticateAccountResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}/authenticate`,
    { body, token: session.token },
  )
}

export async function cancelAccountAuthentication(
  session: ApiSession,
  accountId: string,
): Promise<AccountResponse> {
  return fetchJson<AccountResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}/authenticate`,
    { method: "DELETE", token: session.token },
  )
}

export async function listCodexModels(
  session: ApiSession,
  accountId: string,
): Promise<CodexModelListResponse> {
  return fetchJson<CodexModelListResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}/models`,
    { token: session.token },
  )
}

export async function readCodexRateLimits(
  session: ApiSession,
  accountId: string,
): Promise<CodexRateLimitsResponse> {
  return fetchJson<CodexRateLimitsResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}/rate-limits`,
    { token: session.token },
  )
}

export async function readCodexAccountRateLimits(
  session: ApiSession,
): Promise<AccountRateLimitsResponse> {
  return fetchJson<AccountRateLimitsResponse>(
    session.serverUrl,
    "/api/accounts/rate-limits",
    { token: session.token },
  )
}

export async function completeAccountLogin(
  session: ApiSession,
  accountId: string,
  body: CompleteAccountLoginRequest,
): Promise<AuthenticateAccountResponse> {
  return fetchJson<AuthenticateAccountResponse>(
    session.serverUrl,
    `/api/accounts/${accountId}/authenticate/callback`,
    { body, token: session.token },
  )
}

export async function listWorkspaceDirectory(
  session: ApiSession,
  path?: string,
): Promise<WorkspaceDirectoryResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ""
  return fetchJson<WorkspaceDirectoryResponse>(
    session.serverUrl,
    `/api/workspaces/directories${query}`,
    { token: session.token },
  )
}

export async function listWorkflowTasks(
  session: ApiSession,
  filters: {
    projectPath?: string | null
    status?: string | null
  } = {},
): Promise<WorkflowTaskResponse[]> {
  const query = new URLSearchParams()
  if (filters.projectPath) {
    query.set("projectPath", filters.projectPath)
  }
  if (filters.status) {
    query.set("status", filters.status)
  }
  const suffix = query.size ? `?${query.toString()}` : ""
  return fetchJson<WorkflowTaskResponse[]>(
    session.serverUrl,
    `/api/workflow/tasks${suffix}`,
    { token: session.token },
  )
}

export async function createWorkflowTask(
  session: ApiSession,
  body: CreateWorkflowTaskRequest,
): Promise<WorkflowTaskResponse> {
  return fetchJson<WorkflowTaskResponse>(
    session.serverUrl,
    "/api/workflow/tasks",
    { body, token: session.token },
  )
}

export async function updateWorkflowTask(
  session: ApiSession,
  taskId: string,
  body: UpdateWorkflowTaskRequest,
): Promise<WorkflowTaskResponse> {
  return fetchJson<WorkflowTaskResponse>(
    session.serverUrl,
    `/api/workflow/tasks/${taskId}`,
    { body, method: "PATCH", token: session.token },
  )
}

export async function deleteWorkflowTask(
  session: ApiSession,
  taskId: string,
): Promise<WorkflowTaskResponse> {
  return fetchJson<WorkflowTaskResponse>(
    session.serverUrl,
    `/api/workflow/tasks/${taskId}`,
    { method: "DELETE", token: session.token },
  )
}

export async function createWorkspaceDirectory(
  session: ApiSession,
  body: CreateWorkspaceDirectoryRequest,
): Promise<WorkspaceDirectoryResponse> {
  return fetchJson<WorkspaceDirectoryResponse>(
    session.serverUrl,
    "/api/workspaces/directories",
    { body, token: session.token },
  )
}

export async function listChats(
  session: ApiSession,
): Promise<ChatResponse[]> {
  return fetchJson<ChatResponse[]>(
    session.serverUrl,
    "/api/chats",
    { token: session.token },
  )
}

export async function getChat(
  session: ApiSession,
  chatId: string,
): Promise<ChatResponse> {
  return fetchJson<ChatResponse>(session.serverUrl, `/api/chats/${chatId}`, {
    token: session.token,
  })
}

export async function createChat(
  session: ApiSession,
  body: CreateChatRequest,
): Promise<ChatResponse> {
  return fetchJson<ChatResponse>(session.serverUrl, "/api/chats", {
    body,
    token: session.token,
  })
}

export async function updateChat(
  session: ApiSession,
  chatId: string,
  body: UpdateChatRequest,
): Promise<ChatResponse> {
  return fetchJson<ChatResponse>(session.serverUrl, `/api/chats/${chatId}`, {
    body,
    method: "PATCH",
    token: session.token,
  })
}

export async function archiveChat(
  session: ApiSession,
  chatId: string,
): Promise<ChatResponse> {
  return fetchJson<ChatResponse>(session.serverUrl, `/api/chats/${chatId}`, {
    method: "DELETE",
    token: session.token,
  })
}

export async function getChatMessages(
  session: ApiSession,
  chatId: string,
  afterSequence = 0,
): Promise<MessagePageResponse> {
  return fetchJson<MessagePageResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/messages?afterSequence=${afterSequence}&limit=200`,
    { token: session.token },
  )
}

export async function getChatContext(
  session: ApiSession,
  chatId: string,
): Promise<ChatContextResponse> {
  return fetchJson<ChatContextResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/context`,
    { token: session.token },
  )
}

export async function executeChatMessage(
  session: ApiSession,
  chatId: string,
  body: ExecuteChatRequest,
): Promise<ExecuteChatResponse> {
  return fetchJson<ExecuteChatResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/messages`,
    { body, token: session.token },
  )
}

export async function readChatWorkspaceFile(
  session: ApiSession,
  chatId: string,
  path: string,
  line?: number | null,
): Promise<WorkspaceFileResponse> {
  const query = new URLSearchParams({ path })
  if (line && line > 0) {
    query.set("line", String(line))
  }
  return fetchJson<WorkspaceFileResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/files?${query.toString()}`,
    { token: session.token },
  )
}

export async function getGitStatus(
  session: ApiSession,
  chatId: string,
): Promise<GitStatusResponse> {
  return fetchJson<GitStatusResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/git/status`,
    { token: session.token },
  )
}

export async function getGitBranches(
  session: ApiSession,
  chatId: string,
): Promise<GitBranchesResponse> {
  return fetchJson<GitBranchesResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/git/branches`,
    { token: session.token },
  )
}

export async function getGitDiff(
  session: ApiSession,
  chatId: string,
  path?: string | null,
): Promise<GitDiffResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ""
  return fetchJson<GitDiffResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/git/diff${query}`,
    { token: session.token },
  )
}

export async function getGitHistory(
  session: ApiSession,
  chatId: string,
): Promise<GitHistoryResponse> {
  return fetchJson<GitHistoryResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/git/history`,
    { token: session.token },
  )
}

export async function runGitAction(
  session: ApiSession,
  chatId: string,
  body: GitActionRequest,
): Promise<GitActionResponse> {
  return fetchJson<GitActionResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/git/action`,
    { body, token: session.token },
  )
}

export async function interruptChatRun(
  session: ApiSession,
  chatId: string,
): Promise<InterruptChatRunResponse> {
  return fetchJson<InterruptChatRunResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/interrupt`,
    { body: {}, token: session.token },
  )
}

export async function respondToServerRequest(
  session: ApiSession,
  chatId: string,
  requestId: string,
  body: ServerRequestResponseRequest,
): Promise<ChatMessageResponse> {
  return fetchJson<ChatMessageResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/server-requests/${encodeURIComponent(requestId)}/respond`,
    {
      body,
      token: session.token,
    },
  )
}

export async function steerQueuedChatMessage(
  session: ApiSession,
  chatId: string,
  queueId: string,
): Promise<ChatMessageResponse> {
  return fetchJson<ChatMessageResponse>(
    session.serverUrl,
    `/api/chats/${chatId}/queued/${queueId}/steer`,
    { method: "POST", token: session.token },
  )
}

export async function fetchJson<TResponse>(
  serverUrl: string,
  path: string,
  options: {
    body?: unknown
    method?: string
    token: string | null
  },
): Promise<TResponse> {
  const url = `${serverUrl}${path}`
  const method = options.method ?? (options.body === undefined ? "GET" : "POST")
  let response: Response

  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch (caught) {
    throw new ApiNetworkError({ method, url }, caught)
  }

  const text = await response.text()
  const data = parseJsonBody(text, url)
  if (!response.ok) {
    throw new ApiError(
      [
        `HTTP ${response.status} ${response.statusText || "Request failed"}`,
        `${method} ${url}`,
        readErrorMessage(data) ?? readResponsePreview(text),
      ]
        .filter(Boolean)
        .join("\n"),
      response.status,
      url,
    )
  }

  return data as TResponse
}

function parseJsonBody(text: string, url: string): unknown {
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch (caught) {
    throw new Error(
      [
        "Server returned invalid JSON.",
        url,
        caught instanceof Error ? caught.message : undefined,
        readResponsePreview(text),
      ]
        .filter(Boolean)
        .join("\n"),
      { cause: caught },
    )
  }
}

function formatNetworkError(
  request: {
    method: string
    url: string
  },
  originalError: unknown,
): string {
  const message =
    originalError instanceof Error ? originalError.message : String(originalError)

  return [
    "No HTTP response received.",
    `${request.method} ${request.url}`,
    message,
    "Check the server URL, CORS settings, network reachability, and whether the API is running.",
  ]
    .filter(Boolean)
    .join("\n")
}

function readResponsePreview(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed
}

function readErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }
  const message = (value as { message?: unknown }).message
  if (Array.isArray(message)) {
    return message.join("\n")
  }
  return typeof message === "string" ? message : undefined
}

export function appendMessage(
  page: MessagePageResponse | undefined,
  message: ChatMessageResponse,
): MessagePageResponse {
  const existing = page?.data ?? []
  const withoutDuplicate = existing.filter((entry) => entry.id !== message.id)
  return {
    data: [...withoutDuplicate, message].sort(
      (a, b) => a.sequence - b.sequence,
    ),
    nextCursor: Math.max(message.sequence, page?.nextCursor ?? 0),
  }
}
