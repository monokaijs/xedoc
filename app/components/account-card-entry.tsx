import type {
  AccountAuthMode,
  AccountResponse,
  CodexRateLimitSnapshot,
} from "@/types"
import {
  ExternalLink,
  KeyRound,
  Laptop,
  Loader2,
  MoreVertical,
  Pencil,
  RotateCw,
  Trash2,
  X,
} from "lucide-react"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { normalizeAccountAuthMode } from "@/components/account-auth-dialog"
import { usageCapacityLabel, usageCapacitySeverity } from "@/lib/rate-limits"
import { cn } from "@/lib/utils"

export function AccountCardEntry({
  account,
  authPending,
  authPendingMode,
  cancelPending,
  localActivePending,
  quotaLabel,
  quotaPending,
  quotaSnapshot,
  onAuthenticate,
  onCancelAuthentication,
  onDelete,
  onEdit,
  onSetLocalActive,
  onShowAuthentication,
}: {
  account: AccountResponse
  authPending: boolean
  authPendingMode: AccountAuthMode
  cancelPending: boolean
  localActivePending: boolean
  quotaLabel?: string
  quotaPending: boolean
  quotaSnapshot?: CodexRateLimitSnapshot
  onAuthenticate: (mode: AccountAuthMode) => void
  onCancelAuthentication: () => void
  onDelete: () => void
  onEdit: () => void
  onSetLocalActive: () => void
  onShowAuthentication: () => void
}) {
  const pendingAccountAuthMode =
    normalizeAccountAuthMode(account.lastAuthMode) ?? "browser"
  const browserAuthPending = authPending && authPendingMode === "browser"
  const deviceAuthPending = authPending && authPendingMode === "device"
  const authMode =
    account.status === "AUTHENTICATING" ? pendingAccountAuthMode : "browser"
  const authLabel =
    account.status === "AUTHENTICATING"
      ? "Check"
      : account.status === "CONNECTED"
        ? "Re-authenticate"
        : "Authenticate"
  const canSetLocalActive =
    account.status === "CONNECTED" && !account.isLocalCodexActive
  const authenticatingLabel =
    pendingAccountAuthMode === "device"
      ? "Device login pending"
      : "Browser login pending"

  return (
    <div
      className={cn(
        "rounded-md border bg-background px-3 py-3 text-sm",
        account.isLocalCodexActive &&
          "border-primary/40 bg-primary/5 dark:bg-primary/10",
      )}
    >
      <div className="grid gap-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="min-w-0 max-w-full truncate font-medium">
                {account.displayName}
              </div>
              <AccountPlanBadge planType={quotaSnapshot?.planType} />
              {account.isLocalCodexActive ? <LocalCodexActiveBadge /> : null}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {formatAccountCommand(account)}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <AccountStatusBadge account={account} />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="icon-sm" variant="ghost" />}
              >
                {authPending || cancelPending || localActivePending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <MoreVertical />
                )}
                <span className="sr-only">Account actions</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  disabled={authPending}
                  onClick={() => onAuthenticate(authMode)}
                >
                  {browserAuthPending ? (
                    <Loader2 className="animate-spin" />
                  ) : account.status === "AUTHENTICATING" ? (
                    <RotateCw />
                  ) : (
                    <ExternalLink />
                  )}
                  {account.status === "AUTHENTICATING"
                    ? authLabel
                    : "Normal Auth"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={authPending}
                  onClick={() => onAuthenticate("device")}
                >
                  {deviceAuthPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <KeyRound />
                  )}
                  Device Auth
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canSetLocalActive || localActivePending}
                  onClick={onSetLocalActive}
                >
                  {localActivePending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Laptop />
                  )}
                  {account.isLocalCodexActive
                    ? "Local Active"
                    : "Make Local Active"}
                </DropdownMenuItem>
                {account.status === "AUTHENTICATING" ? (
                  <DropdownMenuItem
                    disabled={cancelPending}
                    variant="destructive"
                    onClick={onCancelAuthentication}
                  >
                    {cancelPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <X />
                    )}
                    Cancel Auth
                  </DropdownMenuItem>
                ) : null}
                {account.status === "AUTHENTICATING" || account.lastAuthUrl ? (
                  <DropdownMenuItem onClick={onShowAuthentication}>
                    <ExternalLink />
                    Authentication Details
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="grid min-w-0 gap-1.5">
            <QuotaSummary
              accountStatus={account.status}
              label={quotaLabel}
              pending={quotaPending}
              snapshot={quotaSnapshot}
            />
            {account.status === "AUTHENTICATING" ? (
              <span className="text-xs text-muted-foreground">
                {authenticatingLabel}
              </span>
            ) : null}
          </div>
          {account.status === "AUTHENTICATING" ? (
            <Button
              className="min-w-0 sm:w-auto"
              disabled={cancelPending}
              size="sm"
              variant="destructive"
              onClick={onCancelAuthentication}
            >
              {cancelPending ? <Loader2 className="animate-spin" /> : <X />}
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function AccountPlanBadge({ planType }: { planType?: string | null }) {
  if (!planType) {
    return null
  }

  return (
    <Badge
      className="border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/35 dark:text-emerald-300"
      variant="outline"
    >
      {formatPlanType(planType)}
    </Badge>
  )
}

function LocalCodexActiveBadge() {
  return (
    <Badge
      className="border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900/70 dark:bg-sky-950/35 dark:text-sky-300"
      variant="outline"
    >
      <Laptop />
      local active
    </Badge>
  )
}

function AccountStatusBadge({ account }: { account: AccountResponse }) {
  const detail = account.lastError?.trim()
  if (!detail) {
    return <StatusBadge status={account.status} />
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex cursor-help" />}>
        <StatusBadge status={account.status} />
      </TooltipTrigger>
      <TooltipContent
        align="start"
        className="max-w-96 whitespace-pre-wrap break-words text-left leading-relaxed"
        side="right"
      >
        {detail}
      </TooltipContent>
    </Tooltip>
  )
}

function QuotaSummary({
  accountStatus,
  label,
  pending,
  snapshot,
}: {
  accountStatus: AccountResponse["status"]
  label?: string
  pending: boolean
  snapshot?: CodexRateLimitSnapshot
}) {
  if (accountStatus !== "CONNECTED") {
    return (
      <div className="text-xs text-muted-foreground">
        {accountStatus === "INVALIDATED"
          ? "Re-authenticate account to load quota."
          : "Connect account to load quota."}
      </div>
    )
  }

  const effectiveLabel = label ?? usageCapacityLabel(snapshot)
  const severity = usageCapacitySeverity(snapshot)
  return (
    <div className="grid gap-1.5">
      <div
        className={cn(
          "inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
          severity === "fiveHour" &&
            "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-900/70 dark:bg-orange-950/35 dark:text-orange-300",
          severity === "weekly" &&
            "border-red-300 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300",
        )}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : null}
        <span>{effectiveLabel}</span>
      </div>
    </div>
  )
}

function formatAccountCommand(account: AccountResponse): string {
  return [account.command, ...(account.args ?? [])].filter(Boolean).join(" ")
}

function formatPlanType(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
}
