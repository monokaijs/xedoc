import type {
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexRateLimitsResponse,
} from "@/types"

export type UsageCapacitySeverity = "fiveHour" | "weekly" | null

export function selectRateLimitSnapshot(
  response?: CodexRateLimitsResponse,
): CodexRateLimitSnapshot | undefined {
  const rawResponse = readRecord(response)
  return normalizeRateLimitSnapshot(
    readRateLimitsByLimitId(response)?.codex ??
      Object.values(readRateLimitsByLimitId(response) ?? {}).find(Boolean) ??
      rawResponse?.rateLimits ??
      rawResponse?.rate_limits ??
      (looksLikeRateLimitSnapshot(rawResponse) ? rawResponse : undefined),
  )
}

export function usageCapacityLabel(
  snapshot?: CodexRateLimitSnapshot,
): string {
  if (!snapshot) {
    return "Usage unavailable"
  }
  if (snapshot.credits?.unlimited) {
    return "Unlimited"
  }
  if (snapshot.rateLimitReachedType) {
    const refillLabel = usageCapacityRefillLabel(snapshot)
    return refillLabel
      ? `Limit reached · refills ${refillLabel}`
      : "Limit reached · refill time unavailable"
  }
  const parts = [
    rateLimitSummary(snapshot.primary, "5h"),
    rateLimitSummary(snapshot.secondary, "W"),
  ]
    .filter(Boolean)
    .join(" · ")
  return parts || "Usage n/a"
}

export function usageCapacityRefillLabel(
  snapshot?: CodexRateLimitSnapshot,
): string | null {
  const resetAt = usageCapacityRefillTimestamp(snapshot)
  return resetAt === null ? null : formatRateLimitResetTime(resetAt)
}

export function formatRateLimitResetTime(value: number): string {
  const timestamp = normalizeResetTimestamp(value)
  if (timestamp <= Date.now()) {
    return "now"
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp))
}

export function usageCapacitySeverity(
  snapshot?: CodexRateLimitSnapshot,
): UsageCapacitySeverity {
  if (!snapshot) {
    return null
  }
  if (rateLimitWindowReached(snapshot.secondary)) {
    return "weekly"
  }
  if (rateLimitWindowReached(snapshot.primary)) {
    return "fiveHour"
  }
  return null
}

export function rateLimitWindowReached(
  window: CodexRateLimitWindow | null | undefined,
): boolean {
  return clampPercent(window?.usedPercent ?? 0) >= 100
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
}

function rateLimitSummary(
  window: CodexRateLimitWindow | null | undefined,
  fallbackLabel: string,
): string | null {
  if (!window) {
    return null
  }
  const remainingPercent = Math.max(0, Math.round(100 - clampPercent(window.usedPercent)))
  return `${compactRateLimitWindowLabel(window, fallbackLabel)} ${remainingPercent}%`
}

function compactRateLimitWindowLabel(
  window: CodexRateLimitWindow | null | undefined,
  fallbackLabel: string,
): string {
  const minutes = window?.windowDurationMins
  if (!minutes) {
    return fallbackLabel
  }
  if (minutes >= 10_080) {
    return "W"
  }
  if (minutes === 300) {
    return "5h"
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`
  }
  return `${minutes}m`
}

function usageCapacityRefillTimestamp(
  snapshot?: CodexRateLimitSnapshot,
): number | null {
  if (!snapshot) {
    return null
  }

  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is CodexRateLimitWindow => !!window,
  )
  const exhaustedWindows = windows.filter(rateLimitWindowReached)
  const candidateWindows = exhaustedWindows.length
    ? exhaustedWindows
    : snapshot.rateLimitReachedType
      ? windows
      : []
  const resetTimestamps = candidateWindows
    .map((window) =>
      window.resetsAt ? normalizeResetTimestamp(window.resetsAt) : null,
    )
    .filter((value): value is number => value !== null)

  if (!resetTimestamps.length) {
    return null
  }

  return exhaustedWindows.length
    ? Math.max(...resetTimestamps)
    : Math.min(...resetTimestamps)
}

function normalizeResetTimestamp(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function normalizeRateLimitSnapshot(
  value: unknown,
): CodexRateLimitSnapshot | undefined {
  const raw = readRecord(value)
  if (!raw) {
    return undefined
  }
  return {
    credits: normalizeCredits(raw.credits),
    limitId: readString(raw.limitId) ?? readString(raw.limit_id),
    limitName: readString(raw.limitName) ?? readString(raw.limit_name),
    planType: readString(raw.planType) ?? readString(raw.plan_type),
    primary: normalizeRateLimitWindow(raw.primary),
    rateLimitReachedType:
      readString(raw.rateLimitReachedType) ??
      readString(raw.rate_limit_reached_type),
    secondary: normalizeRateLimitWindow(raw.secondary),
  } as CodexRateLimitSnapshot
}

function normalizeRateLimitWindow(
  value: unknown,
): CodexRateLimitWindow | null | undefined {
  if (value === null) {
    return null
  }
  const raw = readRecord(value)
  if (!raw) {
    return undefined
  }
  return {
    resetsAt: readNumber(raw.resetsAt) ?? readNumber(raw.resets_at),
    usedPercent:
      readNumber(raw.usedPercent) ?? readNumber(raw.used_percent) ?? 0,
    windowDurationMins:
      readNumber(raw.windowDurationMins) ??
      readNumber(raw.window_duration_mins) ??
      readNumber(raw.window_minutes),
  }
}

function normalizeCredits(
  value: unknown,
): CodexRateLimitSnapshot["credits"] {
  if (value === null) {
    return null
  }
  const raw = readRecord(value)
  if (!raw) {
    return undefined
  }
  return {
    balance: readString(raw.balance) ?? null,
    hasCredits:
      readBoolean(raw.hasCredits) ?? readBoolean(raw.has_credits) ?? true,
    unlimited: readBoolean(raw.unlimited) ?? false,
  }
}

function readRateLimitsByLimitId(
  response: CodexRateLimitsResponse | undefined,
): Record<string, unknown> | undefined {
  const raw = readRecord(response)
  return (
    readRecord(raw?.rateLimitsByLimitId) ??
    readRecord(raw?.rate_limits_by_limit_id)
  )
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function looksLikeRateLimitSnapshot(
  value: Record<string, unknown> | undefined,
): boolean {
  return !!(
    value &&
    ("primary" in value ||
      "secondary" in value ||
      "limitId" in value ||
      "limit_id" in value)
  )
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}
