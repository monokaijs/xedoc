import type { AccountResponse } from "@/types"
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
  usageSummaries,
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
  usageSummaries: Record<string, string>
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
          return (
            <DropdownMenuItem
              disabled={pending || selectionDisabled}
              key={entry.id}
              onClick={() => {
                if (!isSelected) {
                  onSelect(entry.id)
                }
              }}
            >
              <span className="truncate">{entry.displayName}</span>
              {usageSummaries[entry.id] ? (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {usageSummaries[entry.id]}
                </span>
              ) : (
                <span className="ml-auto" />
              )}
              {isSelected ? <Check className="size-4 shrink-0" /> : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
