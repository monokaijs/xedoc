import type {
  CodexCollaborationMode,
  CodexModelOption,
  CodexPermissionMode,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexReasoningEffort,
  ContextWindowUsagePayload,
} from "@/types"
import {
  ArrowUp,
  Brain,
  Clock,
  Cpu,
  Gauge,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Paperclip,
  Plus,
  Shield,
  ShieldCheck,
  Square,
  Zap,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import {
  clampPercent,
  rateLimitWindowReached,
  usageCapacityLabel,
  usageCapacitySeverity,
} from "@/lib/rate-limits"
import { cn } from "@/lib/utils"
import {
  formatEffortLabel,
  formatPlanType,
  formatRateLimitReached,
  formatResetTime,
  formatServiceTierLabel,
  formatTokenCount,
  formatWindowDuration,
  fullRateLimitWindowLabel,
  permissionModeLabel,
  runtimeSummary,
} from "@/screens/chat-runtime-utils"

export function ContextWindowPill({
  usage,
}: {
  usage?: ContextWindowUsagePayload | null
}) {
  if (!usage || usage.tokenLimit <= 0) {
    return null
  }

  const usedPercent = clampPercent(usage.usedPercent)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Context ${Math.round(usedPercent)}% used`}
            className="size-7 px-0 text-xs font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent max-sm:size-8"
            size="icon-sm"
            title={`Context ${Math.round(usedPercent)}% used`}
            variant="ghost"
          />
        }
      >
        <span
          aria-hidden="true"
          className="grid size-4 shrink-0 place-items-center rounded-full text-foreground"
          style={{
            background: `conic-gradient(var(--foreground) ${usedPercent * 3.6}deg, var(--muted) 0deg)`,
          }}
        >
          <span className="size-2 rounded-full bg-background" />
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72" side="top">
        <PopoverHeader>
          <PopoverTitle>Context window</PopoverTitle>
          <PopoverDescription>
            Codex automatically compacts this context when needed.
          </PopoverDescription>
        </PopoverHeader>
        <div className="grid gap-3">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2 text-sm">
              <span className="font-medium">
                {Math.round(usedPercent)}% used
              </span>
              <span className="text-muted-foreground">
                {usage.remainingPercent}% left
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground"
                style={{ width: `${usedPercent}%` }}
              />
            </div>
          </div>
          <div className="rounded-md bg-muted/60 p-2 font-mono text-xs text-muted-foreground">
            {formatTokenCount(usage.tokensUsed)} /{" "}
            {formatTokenCount(usage.tokenLimit)} tokens used
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function UsageCapacityPill({
  pending,
  snapshot,
}: {
  pending: boolean
  snapshot?: CodexRateLimitSnapshot
}) {
  const label = usageCapacityLabel(snapshot)
  const severity = usageCapacitySeverity(snapshot)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className={cn(
              "h-7 max-w-36 justify-start px-2 text-xs font-normal text-foreground hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent max-sm:size-8 max-sm:justify-center max-sm:px-0",
              severity === "fiveHour" &&
                "border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-50 aria-expanded:bg-orange-50 dark:border-orange-900/70 dark:bg-orange-950/35 dark:text-orange-300 dark:hover:bg-orange-950/35 dark:aria-expanded:bg-orange-950/35",
              severity === "weekly" &&
                "border border-red-300 bg-red-50 text-red-700 hover:bg-red-50 aria-expanded:bg-red-50 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300 dark:hover:bg-red-950/35 dark:aria-expanded:bg-red-950/35",
            )}
            size="sm"
            title={label}
            variant="ghost"
          />
        }
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Zap className="size-3" />
        )}
        <span className="truncate max-sm:sr-only">{label}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" side="top">
        <PopoverHeader>
          <PopoverTitle>Usage capacity</PopoverTitle>
          <PopoverDescription>
            Current Codex account limits refresh automatically.
          </PopoverDescription>
        </PopoverHeader>
        <UsageCapacityDetails pending={pending} snapshot={snapshot} />
      </PopoverContent>
    </Popover>
  )
}

export function ChatInputPlanModeBadge({ visible }: { visible: boolean }) {
  if (!visible) {
    return null
  }
  return (
    <Badge
      className="pointer-events-none absolute right-1.5 top-1.5 z-10 border-primary/25 bg-background/95 text-foreground shadow-sm backdrop-blur dark:border-primary/40"
      variant="outline"
    >
      <ListChecks />
      <span>Plan mode</span>
    </Badge>
  )
}

export function PlanModeSelector({
  attachmentDisabled,
  disabled,
  mode,
  modeDisabled,
  onAttachFile,
  onAttachImage,
  onSelectMode,
  pending,
}: {
  attachmentDisabled?: boolean
  disabled?: boolean
  mode: CodexCollaborationMode
  modeDisabled?: boolean
  onAttachFile?: () => void
  onAttachImage?: () => void
  onSelectMode: (mode: CodexCollaborationMode) => void
  pending?: boolean
}) {
  const planEnabled = mode === "plan"
  const attachmentsLocked = attachmentDisabled || disabled
  const planLocked = disabled || modeDisabled || pending
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Chat options"
            className="shrink-0"
            disabled={disabled}
            size="icon-sm"
            variant={planEnabled ? "secondary" : "ghost"}
          />
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : <Plus />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          className="gap-3 py-2"
          disabled={planLocked}
          onClick={(event) => {
            event.preventDefault()
            onSelectMode(planEnabled ? "default" : "plan")
          }}
        >
          <ListChecks />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span>Plan mode</span>
          </span>
          <Switch
            checked={planEnabled}
            className="pointer-events-none"
            size="sm"
            tabIndex={-1}
          />
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-3 py-2"
          disabled={attachmentsLocked || !onAttachImage}
          onClick={onAttachImage}
        >
          <ImageIcon />
          <span>Attach image</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-3 py-2"
          disabled={attachmentsLocked || !onAttachFile}
          onClick={onAttachFile}
        >
          <Paperclip />
          <span>Attach workspace file</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function PermissionModeSelector({
  disabled,
  mode,
  onSelectMode,
  pending,
}: {
  disabled?: boolean
  mode: CodexPermissionMode
  onSelectMode: (mode: CodexPermissionMode) => void
  pending?: boolean
}) {
  const fullAccess = mode === "fullAccess"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={permissionModeLabel(mode)}
            className={cn(
              "max-w-40 justify-start max-sm:size-8 max-sm:justify-center max-sm:px-0",
              fullAccess &&
                "border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 aria-expanded:bg-orange-100 dark:border-orange-900/70 dark:bg-orange-950/35 dark:text-orange-300 dark:hover:bg-orange-950/45 dark:aria-expanded:bg-orange-950/45",
            )}
            disabled={disabled || pending}
            size="sm"
            title={permissionModeLabel(mode)}
            variant="ghost"
          />
        }
      >
        {pending ? (
          <Loader2 className="animate-spin" />
        ) : fullAccess ? (
          <ShieldCheck />
        ) : (
          <Shield />
        )}
        <span className="truncate max-sm:sr-only">
          {permissionModeLabel(mode)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) =>
            onSelectMode(value === "fullAccess" ? "fullAccess" : "default")
          }
        >
          <DropdownMenuRadioItem value="default">
            <span className="grid min-w-0 gap-0.5">
              <span>Default</span>
              <span className="text-xs text-muted-foreground">
                Codex asks as needed.
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            className="text-orange-700 dark:text-orange-300"
            value="fullAccess"
          >
            <span className="grid min-w-0 gap-0.5">
              <span>Full access</span>
              <span className="text-xs text-muted-foreground">
                No sandbox or approval prompts.
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ComposerActionButton({
  hasDraft,
  loading,
  onSend,
  onSteer,
  onStop,
  running = false,
  sendDisabled,
  steerDisabled,
  stopPending = false,
}: {
  hasDraft?: boolean
  loading?: boolean
  onSend: () => void
  onSteer?: () => void
  onStop?: () => void
  running?: boolean
  sendDisabled?: boolean
  steerDisabled?: boolean
  stopPending?: boolean
}) {
  if (running && !hasDraft) {
    return (
      <Button
        aria-label="Stop task"
        className="size-9 rounded-full"
        disabled={stopPending || !onStop}
        size="icon"
        title="Stop task"
        type="button"
        variant="secondary"
        onClick={onStop}
      >
        {stopPending ? <Loader2 className="animate-spin" /> : <Square />}
      </Button>
    )
  }

  if (running && hasDraft) {
    return (
      <div className="group relative flex shrink-0">
        <div className="absolute right-0 bottom-full z-20 hidden min-w-48 pb-2 group-focus-within:block group-hover:block">
          <div className="grid gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <button
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              disabled={steerDisabled || loading || !onSteer}
              type="button"
              onClick={onSteer}
            >
              <ArrowUp className="size-4 shrink-0" />
              <span className="min-w-0">Steer active task</span>
            </button>
            <button
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
              disabled={sendDisabled || loading}
              type="button"
              onClick={onSend}
            >
              <Clock className="size-4 shrink-0" />
              <span className="min-w-0">Queue after current task</span>
            </button>
          </div>
        </div>
        <Button
          aria-label="Queue message"
          className="size-9 rounded-full"
          disabled={sendDisabled || loading}
          size="icon"
          title="Queue message"
          type="button"
          onClick={onSend}
        >
          {loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    )
  }

  return (
    <Button
      aria-label="Send message"
      className="size-9 rounded-full"
      disabled={sendDisabled || loading}
      size="icon"
      type="button"
      onClick={onSend}
    >
      {loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
    </Button>
  )
}

export function ChatRuntimeSelector({
  activeReasoningEffort,
  disabled,
  modelOptions,
  modelValue,
  onSelectModel,
  onSelectReasoning,
  onSelectServiceTier,
  pending,
  reasoningOptions,
  reasoningValue,
  selectedModel,
  serviceTierOptions,
  serviceTierValue,
}: {
  activeReasoningEffort?: CodexReasoningEffort | null
  disabled: boolean
  modelOptions: CodexModelOption[]
  modelValue: string
  onSelectModel: (value: string) => void
  onSelectReasoning: (value: string) => void
  onSelectServiceTier: (value: string) => void
  pending: boolean
  reasoningOptions: CodexReasoningEffort[]
  reasoningValue: string
  selectedModel?: CodexModelOption
  serviceTierOptions: string[]
  serviceTierValue: string
}) {
  const summary = runtimeSummary({
    effort: activeReasoningEffort,
    model: selectedModel,
    modelValue,
    serviceTier: serviceTierValue,
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={summary}
            className="max-w-64 justify-start max-sm:size-8 max-sm:justify-center max-sm:px-0"
            disabled={disabled || pending}
            size="sm"
            title={summary}
            variant="ghost"
          />
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : <Cpu />}
        <span className="truncate max-sm:sr-only">{summary}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,6rem)_auto]">
            <Brain />
            <span>Intelligence</span>
            <span className="truncate text-right text-xs text-muted-foreground">
              {formatEffortLabel(activeReasoningEffort)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuRadioGroup
              value={reasoningValue}
              onValueChange={onSelectReasoning}
            >
              <DropdownMenuRadioItem value="">
                Model default
              </DropdownMenuRadioItem>
              {reasoningOptions.map((effort) => (
                <DropdownMenuRadioItem key={effort} value={effort}>
                  {formatEffortLabel(effort)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,6rem)_auto]">
            <Cpu />
            <span>Model</span>
            <span className="truncate text-right text-xs text-muted-foreground">
              {(selectedModel?.displayName ?? modelValue) || "Default"}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <DropdownMenuRadioGroup
              value={modelValue}
              onValueChange={onSelectModel}
            >
              <DropdownMenuRadioItem value="">
                Default model
              </DropdownMenuRadioItem>
              {modelOptions.map((model) => (
                <DropdownMenuRadioItem key={model.id} value={model.model}>
                  <span className="truncate">{model.displayName}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,6rem)_auto]"
            disabled={!serviceTierOptions.length}
          >
            <Gauge />
            <span>Speed</span>
            <span className="truncate text-right text-xs text-muted-foreground">
              {formatServiceTierLabel(serviceTierValue)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuRadioGroup
              value={serviceTierValue}
              onValueChange={onSelectServiceTier}
            >
              <DropdownMenuRadioItem value="">
                Default speed
              </DropdownMenuRadioItem>
              {serviceTierOptions.map((tier) => (
                <DropdownMenuRadioItem key={tier} value={tier}>
                  {formatServiceTierLabel(tier)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function UsageCapacityDetails({
  pending,
  snapshot,
}: {
  pending: boolean
  snapshot?: CodexRateLimitSnapshot
}) {
  if (!snapshot) {
    return (
      <div className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
        {pending ? "Loading limits..." : "Usage limits are unavailable."}
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      <div className="grid gap-1 text-xs text-muted-foreground">
        {snapshot.limitName ? <div>{snapshot.limitName}</div> : null}
        {snapshot.planType ? (
          <div>Plan: {formatPlanType(snapshot.planType)}</div>
        ) : null}
        {snapshot.credits ? (
          <div>
            Credits:{" "}
            {snapshot.credits.unlimited
              ? "unlimited"
              : (snapshot.credits.balance ??
                (snapshot.credits.hasCredits ? "available" : "depleted"))}
          </div>
        ) : null}
        {snapshot.rateLimitReachedType ? (
          <div className="text-destructive">
            {formatRateLimitReached(snapshot.rateLimitReachedType)}
          </div>
        ) : null}
      </div>
      <CapacityRow
        fallbackLabel="5-hour limit"
        severity="fiveHour"
        window={snapshot.primary}
      />
      <CapacityRow
        fallbackLabel="Weekly limit"
        severity="weekly"
        window={snapshot.secondary}
      />
    </div>
  )
}

export function CapacityRow({
  fallbackLabel,
  severity,
  window,
}: {
  fallbackLabel: string
  severity: "fiveHour" | "weekly"
  window?: CodexRateLimitWindow | null
}) {
  const usedPercent = clampPercent(window?.usedPercent ?? 0)
  const remainingPercent = Math.max(0, Math.round(100 - usedPercent))
  const reached = rateLimitWindowReached(window)

  return (
    <div
      className={cn(
        "grid gap-1.5 rounded-md border p-2",
        reached &&
          severity === "fiveHour" &&
          "border-orange-300 bg-orange-50/70 text-orange-800 dark:border-orange-900/70 dark:bg-orange-950/25 dark:text-orange-200",
        reached &&
          severity === "weekly" &&
          "border-red-300 bg-red-50/70 text-red-800 dark:border-red-900/70 dark:bg-red-950/25 dark:text-red-200",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {fullRateLimitWindowLabel(window, fallbackLabel)}
        </span>
        <span
          className={cn(
            "text-muted-foreground",
            reached && "font-medium text-current",
          )}
        >
          {window ? `${remainingPercent}% left` : "Unavailable"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-foreground",
            reached && severity === "fiveHour" && "bg-orange-500",
            reached && severity === "weekly" && "bg-red-500",
          )}
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground",
          reached && "text-current/80",
        )}
      >
        {window ? <span>{Math.round(usedPercent)}% used</span> : null}
        {window?.windowDurationMins ? (
          <span>{formatWindowDuration(window.windowDurationMins)}</span>
        ) : null}
        {window?.resetsAt ? (
          <span>Resets {formatResetTime(window.resetsAt)}</span>
        ) : null}
      </div>
    </div>
  )
}
