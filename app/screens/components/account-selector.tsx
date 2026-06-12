import type {
  AccountResponse,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
} from "@/types"
import { Check, Loader2, RefreshCw, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { clampPercent } from "@/lib/rate-limits"
import { cn } from "@/lib/utils"

export function CodexAccountSelector({
  account,
  autoRotate,
  autoRotateDisabled,
  connectedAccounts,
  disabled,
  onAutoRotateChange,
  onSelect,
  pending,
  selectedAccountId,
  selectionDisabled,
  usageSnapshots,
}: {
  account?: AccountResponse
  autoRotate?: boolean
  autoRotateDisabled?: boolean
  connectedAccounts: AccountResponse[]
  disabled?: boolean
  onAutoRotateChange?: (enabled: boolean) => void
  onSelect: (accountId: string) => void
  pending?: boolean
  selectedAccountId: string
  selectionDisabled?: boolean
  usageSnapshots: Record<string, CodexRateLimitSnapshot>
}) {
  const label = autoRotate
    ? "Auto"
    : (account?.displayName ?? "Choose account")
  const title =
    autoRotate && account
      ? `Auto: ${account.displayName}`
      : (account?.displayName ?? "Choose account")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={title}
            className="max-w-44 justify-start max-sm:size-8 max-sm:justify-center max-sm:px-0"
            disabled={disabled || pending}
            size="sm"
            title={title}
            variant={autoRotate ? "secondary" : "ghost"}
          />
        }
      >
        {pending ? (
          <Loader2 className="animate-spin" />
        ) : autoRotate ? (
          <RefreshCw />
        ) : (
          <UserRound />
        )}
        <span className="truncate max-sm:sr-only">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {onAutoRotateChange ? (
          <>
            <DropdownMenuItem
              className="gap-3 py-2"
              disabled={autoRotateDisabled || pending}
              onClick={(event) => {
                event.preventDefault()
                onAutoRotateChange(!autoRotate)
              }}
            >
              <RefreshCw />
              <span className="min-w-0 flex-1">Auto</span>
              <Switch
                checked={!!autoRotate}
                className="pointer-events-none"
                size="sm"
                tabIndex={-1}
              />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {connectedAccounts.map((entry) => {
          const isSelected = entry.id === selectedAccountId
          const snapshot = usageSnapshots[entry.id]
          return (
            <DropdownMenuItem
              className="group/account-item flex-col items-stretch gap-1.5 py-2"
              disabled={pending || selectionDisabled}
              key={entry.id}
              onClick={() => {
                if (!isSelected) {
                  onSelect(entry.id)
                }
              }}
            >
              <div className="flex w-full items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {entry.displayName}
                </span>
                <AccountResetTime snapshot={snapshot} />
                {isSelected ? (
                  <Check className="size-4 shrink-0" />
                ) : (
                  <span aria-hidden="true" className="size-4 shrink-0" />
                )}
              </div>
              <AccountUsageBars snapshot={snapshot} />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountResetTime({
  snapshot,
}: {
  snapshot?: CodexRateLimitSnapshot
}) {
  const resetAt = selectResetTimestamp(snapshot)
  const label = resetAt ? formatRelativeResetTime(resetAt) : "n/a"

  return (
    <span
      className="w-14 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground"
      title={resetAt ? `Resets ${label}` : "Reset unavailable"}
    >
      {label}
    </span>
  )
}

function AccountUsageBars({
  snapshot,
}: {
  snapshot?: CodexRateLimitSnapshot
}) {
  const fillClassName = weeklyProgressColor(snapshot)

  return (
    <div className="w-full">
      <div className="group-hover/account-item:hidden group-focus/account-item:hidden">
        <LimitProgressBar
          fillClassName={fillClassName}
          label="Weekly limit"
          window={snapshot?.secondary}
        />
      </div>
      <div className="hidden grid-cols-2 gap-1 group-hover/account-item:grid group-focus/account-item:grid">
        <LimitProgressBar
          fillClassName={fillClassName}
          label="5-hour limit"
          window={snapshot?.primary}
        />
        <LimitProgressBar
          fillClassName={fillClassName}
          label="Weekly limit"
          window={snapshot?.secondary}
        />
      </div>
    </div>
  )
}

function LimitProgressBar({
  fillClassName,
  label,
  window,
}: {
  fillClassName: string
  label: string
  window?: CodexRateLimitWindow | null
}) {
  const usedPercent = clampPercent(window?.usedPercent ?? 0)
  const roundedPercent = Math.round(usedPercent)

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={window ? roundedPercent : undefined}
      aria-valuetext={window ? undefined : "Unavailable"}
      className="h-1.5 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      title={
        window
          ? `${label}: ${roundedPercent}% used`
          : `${label}: unavailable`
      }
    >
      <div
        className={cn("h-full rounded-full", fillClassName)}
        style={{ width: `${usedPercent}%` }}
      />
    </div>
  )
}

function weeklyProgressColor(
  snapshot?: CodexRateLimitSnapshot,
): string {
  if (!snapshot) {
    return "bg-muted-foreground/40"
  }
  if (snapshot.rateLimitReachedType) {
    return "bg-red-500"
  }
  if (snapshot.credits?.unlimited) {
    return "bg-emerald-500"
  }

  const weeklyWindow = snapshot.secondary
  if (!weeklyWindow) {
    return "bg-muted-foreground/40"
  }

  const weeklyUsedPercent = clampPercent(weeklyWindow.usedPercent)
  if (weeklyUsedPercent >= 90) {
    return "bg-red-500"
  }
  if (weeklyUsedPercent >= 75) {
    return "bg-orange-500"
  }
  if (weeklyUsedPercent >= 50) {
    return "bg-amber-500"
  }
  return "bg-emerald-500"
}

function selectResetTimestamp(
  snapshot?: CodexRateLimitSnapshot,
): number | null {
  if (!snapshot) {
    return null
  }

  const reachedResets = [snapshot.secondary, snapshot.primary]
    .filter(isWindowReached)
    .map(windowResetTimestamp)
    .filter((value): value is number => value !== null)

  if (reachedResets.length) {
    return Math.max(...reachedResets)
  }

  return (
    windowResetTimestamp(snapshot.secondary) ??
    windowResetTimestamp(snapshot.primary)
  )
}

function isWindowReached(
  window: CodexRateLimitWindow | null | undefined,
): window is CodexRateLimitWindow {
  return clampPercent(window?.usedPercent ?? 0) >= 100
}

function windowResetTimestamp(
  window: CodexRateLimitWindow | null | undefined,
): number | null {
  return window?.resetsAt ? normalizeResetTimestamp(window.resetsAt) : null
}

function normalizeResetTimestamp(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function formatRelativeResetTime(value: number): string {
  const deltaMs = value - Date.now()
  if (deltaMs <= 30_000) {
    return "now"
  }

  const minuteMs = 60 * 1000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  const weekMs = 7 * dayMs

  if (deltaMs < hourMs) {
    return `in ${Math.ceil(deltaMs / minuteMs)}m`
  }
  if (deltaMs < dayMs) {
    return `in ${Math.ceil(deltaMs / hourMs)}h`
  }
  if (deltaMs < weekMs) {
    return `in ${Math.ceil(deltaMs / dayMs)}d`
  }
  return `in ${Math.ceil(deltaMs / weekMs)}w`
}
