import type {
  AccountResponse,
  ChatResponse,
  CodexModelOption,
  CodexPermissionMode,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexReasoningEffort,
  MessagePageResponse,
} from "@/types"
import { ApiError, appendMessage } from "@/lib/api"
import { clampPercent } from "@/lib/rate-limits"
import type { ComposerAttachment } from "@/screens/components/composer-attachments"

export function autoRotateTargetAccountForChat(
  chat: ChatResponse | undefined,
  account: AccountResponse | undefined,
  bestAvailableAccount: AccountResponse | undefined,
  snapshots: Record<string, CodexRateLimitSnapshot>,
): AccountResponse | null {
  if (
    !chat?.autoRotateAccount ||
    chat.status === "RUNNING" ||
    !bestAvailableAccount ||
    bestAvailableAccount.id === chat.accountId
  ) {
    return null
  }

  if (accountAvailabilityScore(snapshots[bestAvailableAccount.id]) < 0) {
    return null
  }

  const currentAccountUnavailable =
    !account ||
    account.status !== "CONNECTED" ||
    accountAvailabilityScore(snapshots[account.id]) < 0

  return currentAccountUnavailable ? bestAvailableAccount : null
}

export function selectedModelOption(
  models: CodexModelOption[],
  value?: string | null,
): CodexModelOption | undefined {
  if (value) {
    return models.find((model) => model.model === value || model.id === value)
  }
  return models.find((model) => model.isDefault) ?? models[0]
}

export function selectBestAvailableAccount(
  accounts: AccountResponse[],
  snapshots: Record<string, CodexRateLimitSnapshot>,
): AccountResponse | undefined {
  let bestAccount: AccountResponse | undefined
  let bestScore = -1

  for (const account of accounts) {
    const score = accountAvailabilityScore(snapshots[account.id])
    if (score > bestScore) {
      bestAccount = account
      bestScore = score
    }
  }

  return bestAccount
}

export function hasAvailableAccountSnapshot(
  accounts: AccountResponse[],
  snapshots: Record<string, CodexRateLimitSnapshot>,
): boolean {
  return accounts.some((account) => {
    const snapshot = snapshots[account.id]
    return !!snapshot && accountAvailabilityScore(snapshot) >= 0
  })
}

export function accountAvailabilityScore(
  snapshot?: CodexRateLimitSnapshot,
): number {
  if (!snapshot) {
    return 0
  }
  if (snapshot.rateLimitReachedType) {
    return -1
  }
  if (snapshot.credits?.unlimited) {
    return 101
  }

  const remainingPercents = [snapshot.primary, snapshot.secondary]
    .filter((window): window is CodexRateLimitWindow => !!window)
    .map((window) => 100 - clampPercent(window.usedPercent))

  if (!remainingPercents.length) {
    return 0
  }
  const score = Math.min(...remainingPercents)
  return score <= 0 ? -1 : score
}

export function fullRateLimitWindowLabel(
  window: CodexRateLimitWindow | null | undefined,
  fallbackLabel: string,
): string {
  const minutes = window?.windowDurationMins
  if (!minutes) {
    return fallbackLabel
  }
  if (minutes >= 10_080) {
    return "Weekly limit"
  }
  if (minutes === 300) {
    return "5-hour limit"
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}-hour limit`
  }
  return `${minutes}-minute limit`
}

export function formatWindowDuration(minutes: number): string {
  if (minutes >= 10_080) {
    return `${Math.round(minutes / 10_080)} week window`
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} hour window`
  }
  return `${minutes} minute window`
}

export function formatResetTime(value: number): string {
  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp))
}

export function formatChatListDate(value: string | Date): string {
  const date = new Date(value)
  const elapsedMs = Math.max(0, Date.now() - date.getTime())
  const minuteMs = 60 * 1000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs

  if (elapsedMs < 2 * minuteMs) {
    return "just now"
  }
  if (elapsedMs < hourMs) {
    return `${Math.floor(elapsedMs / minuteMs)}m ago`
  }
  if (elapsedMs < dayMs) {
    return `${Math.floor(elapsedMs / hourMs)}h ago`
  }
  if (elapsedMs < 2 * dayMs) {
    return "yesterday"
  }
  if (elapsedMs <= 3 * dayMs) {
    return `${Math.floor(elapsedMs / dayMs)} days ago`
  }

  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date)
}

export function chatFolderName(workingDirectory?: string | null): string {
  const path = workingDirectory?.trim()
  if (!path) {
    return "No folder"
  }

  const trimmed = path.replace(/[\\/]+$/, "")
  if (!trimmed) {
    return path
  }

  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? trimmed
}

export function chatFolderPath(workingDirectory?: string | null): string {
  const path = workingDirectory?.trim()
  if (!path) {
    return "No folder"
  }
  return path.replace(/[\\/]+$/, "") || path
}

export function chatFolderKey(workingDirectory?: string | null): string {
  return chatFolderPath(workingDirectory)
}

export function isConcreteFolderPath(path: string): boolean {
  return !!path.trim() && path !== "No folder"
}

export function displayNameForPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || path
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${formatCompactNumber(value / 1_000_000)}M`
  }
  if (value >= 1_000) {
    return `${formatCompactNumber(value / 1_000)}k`
  }
  return String(Math.max(0, Math.round(value)))
}

export function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function formatPlanType(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
}

export function formatRateLimitReached(value: string): string {
  return formatPlanType(value)
}

export function runtimeSummary({
  effort,
  model,
  modelValue,
  serviceTier,
}: {
  effort?: CodexReasoningEffort | null
  model?: CodexModelOption
  modelValue: string
  serviceTier: string
}): string {
  return [
    (model?.displayName ?? modelValue) || "Model",
    effort ? formatEffortLabel(effort) : null,
    serviceTier ? formatServiceTierLabel(serviceTier) : null,
  ]
    .filter(Boolean)
    .join(" ")
}

export function formatEffortLabel(value?: CodexReasoningEffort | null): string {
  if (!value) {
    return "Default"
  }
  if (value === "xhigh") {
    return "Extra High"
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

export function formatServiceTierLabel(value: string): string {
  if (!value) {
    return "Default"
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

export function permissionModeLabel(value: CodexPermissionMode): string {
  return value === "fullAccess" ? "Full access" : "Default"
}

export function appendMessages(
  page: MessagePageResponse | undefined,
  messages: MessagePageResponse["data"],
): MessagePageResponse {
  let current = page
  for (const message of messages) {
    current = appendMessage(current, message)
  }
  return current ?? { data: [], nextCursor: null }
}

export function executeResponseMessages(response: {
  assistantMessage?: MessagePageResponse["data"][number] | null
  message: MessagePageResponse["data"][number]
}): MessagePageResponse["data"] {
  return [response.message, response.assistantMessage].filter(
    (message): message is MessagePageResponse["data"][number] => !!message,
  )
}

export function upsertAccount(
  accounts: AccountResponse[] | undefined,
  account: AccountResponse,
): AccountResponse[] {
  const existing = accounts ?? []
  if (existing.some((entry) => entry.id === account.id)) {
    return existing.map((entry) => (entry.id === account.id ? account : entry))
  }
  return [...existing, account]
}

export function canSend(
  content: string,
  workingDirectory: string,
  account?: AccountResponse,
  attachments: ComposerAttachment[] = [],
) {
  return (
    (!!content.trim() || attachments.length > 0) &&
    !!workingDirectory.trim() &&
    !!account
  )
}

export function routeWorkingDirectoryFromState(state: unknown): string {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return ""
  }
  const value = (state as { workingDirectory?: unknown }).workingDirectory
  return typeof value === "string" ? value.trim() : ""
}

export function isAccountTokenInvalidatedError(error: unknown): boolean {
  if (!error) {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return (
    (error instanceof ApiError && error.status === 401) ||
    /token_invalidated|authentication token .*invalidated|re-authenticate this account/i.test(
      message,
    )
  )
}

export function readError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Request failed."
}
