import {
  Plus,
  SquarePen,
  Terminal as TerminalIcon,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAgentSoundsPreference } from "@/lib/agent-sounds"
import { cn } from "@/lib/utils"

export function HeaderTerminalButton({
  active,
  className,
  compact = false,
  count,
  disabled,
  onToggle,
}: {
  active: boolean
  className?: string
  compact?: boolean
  count?: number
  disabled: boolean
  onToggle: () => void
}) {
  const terminalCount = count ?? 0
  return (
    <Button
      aria-label="Terminal"
      aria-pressed={active}
      className={cn(
        compact
          ? "relative"
          : "h-7 max-w-56 justify-start gap-1.5 px-2 text-xs",
        className,
      )}
      disabled={disabled}
      size={compact ? "icon" : "sm"}
      title={disabled ? "Choose a working directory" : "Terminal"}
      type="button"
      variant="ghost"
      onClick={onToggle}
    >
      <TerminalIcon className="size-3.5" />
      <span className={compact ? "sr-only" : "min-w-0 truncate"}>Terminal</span>
      {terminalCount > 0 ? (
        <span
          className={cn(
            "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-sidebar-accent px-1 text-[0.65rem] leading-none text-sidebar-accent-foreground",
            compact ? "absolute -right-1 -top-1" : "ml-0.5",
          )}
        >
          {terminalCount}
        </span>
      ) : null}
    </Button>
  )
}

export function HeaderCreateMenu({
  onAddAccount,
  onNewChat,
}: {
  onAddAccount: () => void
  onNewChat: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon" variant="ghost" />}>
        <Plus className="size-4" />
        <span className="sr-only">Create</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={onNewChat}>
          <SquarePen />
          New chat
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAddAccount}>
          <UserRound />
          Add account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function HeaderAgentSoundButton() {
  const [enabled, setEnabled] = useAgentSoundsPreference()
  return (
    <Button
      aria-label={enabled ? "Disable agent sounds" : "Enable agent sounds"}
      aria-pressed={enabled}
      size="icon"
      title={enabled ? "Agent sounds on" : "Agent sounds off"}
      type="button"
      variant="ghost"
      onClick={() => setEnabled(!enabled)}
    >
      {enabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
    </Button>
  )
}
