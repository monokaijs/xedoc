import type {
  GitBranchesResponse,
  GitFileStatus,
  GitStatusResponse,
} from "@/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  ChevronDown,
  Clock,
  Download,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  ListChecks,
  Plus,
  RefreshCw,
  Upload,
  X,
} from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  getGitBranches,
  getGitDiff,
  getGitHistory,
  getGitStatus,
  runGitAction,
} from "@/lib/api"
import type { WebSession } from "@/lib/session-storage"
import { cn } from "@/lib/utils"
import { readError } from "@/screens/chat-runtime-utils"
import { GitDiffViewer } from "@/screens/components/git-diff-viewer"
import {
  GitHistoryPanel,
  formatGitCommitDate,
} from "@/screens/components/git-history-panel"

export function GitStatusChip({
  active = false,
  chatId,
  className,
  compact = false,
  disabled,
  onToggle,
  session,
}: {
  active?: boolean
  chatId: string
  className?: string
  compact?: boolean
  disabled?: boolean
  onToggle: () => void
  session: WebSession
}) {
  const statusQuery = useQuery({
    enabled: !!chatId,
    queryKey: ["git-status", chatId],
    queryFn: () => getGitStatus(session, chatId),
    refetchInterval: 20_000,
    retry: false,
  })
  const status = statusQuery.data
  if (status && !status.isRepo) {
    return null
  }
  const label = status?.branch ?? "Git"
  const dirty = status ? !status.clean : false
  const aheadBehind = status ? formatAheadBehind(status) : ""
  return (
    <Button
      aria-label={`Git${label ? `: ${label}` : ""}`}
      aria-pressed={active}
      className={cn(
        compact
          ? "relative"
          : "h-7 max-w-56 justify-start gap-1.5 px-2 text-xs",
        active && "text-foreground",
        className,
      )}
      disabled={disabled || (statusQuery.isLoading && !status)}
      size={compact ? "icon" : "sm"}
      title={label}
      type="button"
      variant="ghost"
      onClick={onToggle}
    >
      <GitBranch className="size-3.5" />
      {compact && status ? (
        <span
          className={cn(
            "absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
            dirty ? "bg-amber-500" : "bg-emerald-500",
          )}
        />
      ) : (
        <>
          <span className="min-w-0 truncate">{label}</span>
          {aheadBehind ? (
            <span className="shrink-0 text-muted-foreground">
              {aheadBehind}
            </span>
          ) : null}
          <span
            className={cn(
              "ml-0.5 size-1.5 shrink-0 rounded-full",
              dirty ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
        </>
      )}
    </Button>
  )
}

export function GitPanel({
  chatId,
  className,
  disabled,
  onClose,
  session,
  status,
}: {
  chatId: string
  className?: string
  disabled?: boolean
  onClose?: () => void
  session: WebSession
  status?: GitStatusResponse
}) {
  const queryClient = useQueryClient()
  const [branchFilter, setBranchFilter] = useState("")
  const [commitMessage, setCommitMessage] = useState("")
  const [newBranchName, setNewBranchName] = useState("")
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(
    null,
  )
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const statusQuery = useQuery({
    enabled: !!chatId,
    queryKey: ["git-status", chatId],
    queryFn: () => getGitStatus(session, chatId),
    refetchInterval: 20_000,
    retry: false,
    initialData: status,
  })
  const gitQueriesEnabled = !!chatId && statusQuery.data?.isRepo === true
  const branchesQuery = useQuery({
    enabled: gitQueriesEnabled,
    queryKey: ["git-branches", chatId],
    queryFn: () => getGitBranches(session, chatId),
    retry: false,
  })
  const diffQuery = useQuery({
    enabled: gitQueriesEnabled,
    queryKey: ["git-diff", chatId, selectedFilePath],
    queryFn: () => getGitDiff(session, chatId, selectedFilePath),
    retry: false,
  })
  const historyQuery = useQuery({
    enabled: gitQueriesEnabled,
    queryKey: ["git-history", chatId],
    queryFn: () => getGitHistory(session, chatId),
    retry: false,
  })
  const actionMutation = useMutation({
    mutationFn: runGitActionPayload,
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (response) => {
      toast.success(response.message)
      setCommitMessage("")
      setNewBranchName("")
      queryClient.setQueryData(["git-status", chatId], response.status)
      void queryClient.invalidateQueries({ queryKey: ["git-branches", chatId] })
      void queryClient.invalidateQueries({ queryKey: ["git-diff", chatId] })
      void queryClient.invalidateQueries({ queryKey: ["git-history", chatId] })
    },
  })
  const branches = filterGitBranches(branchesQuery.data, branchFilter)
  const currentStatus = actionMutation.data?.status ?? statusQuery.data
  const changedFiles = useMemo(
    () => currentStatus?.changedFiles ?? [],
    [currentStatus],
  )
  const commits = useMemo(
    () => historyQuery.data?.commits ?? [],
    [historyQuery.data],
  )
  const selectedCommit =
    commits.find((commit) => commit.hash === selectedCommitHash) ?? null
  const locked =
    disabled ||
    actionMutation.isPending ||
    !currentStatus ||
    currentStatus.isRepo === false
  const diffText =
    diffQuery.data?.diff?.trim() || diffQuery.data?.stat?.trim() || ""
  const diffTitle = selectedFilePath ?? "All changes"

  useEffect(() => {
    setSelectedFilePath((current) => {
      if (!changedFiles.length) {
        return null
      }
      if (current && changedFiles.some((file) => file.path === current)) {
        return current
      }
      return changedFiles[0]?.path ?? null
    })
  }, [changedFiles])

  useEffect(() => {
    setSelectedCommitHash((current) => {
      if (!commits.length) {
        return null
      }
      if (current && commits.some((commit) => commit.hash === current)) {
        return current
      }
      return commits[0]?.hash ?? null
    })
  }, [commits])

  function runGitActionPayload(body: Parameters<typeof runGitAction>[2]) {
    return runGitAction(session, chatId, body)
  }

  const refreshGit = () => {
    void queryClient.invalidateQueries({
      queryKey: ["git-status", chatId],
    })
    void queryClient.invalidateQueries({
      queryKey: ["git-branches", chatId],
    })
    void queryClient.invalidateQueries({
      queryKey: ["git-diff", chatId],
    })
    void queryClient.invalidateQueries({
      queryKey: ["git-history", chatId],
    })
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        className,
      )}
    >
      <header className="shrink-0 border-b bg-sidebar/55 px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
            <GitCommitHorizontal className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-semibold">Git</div>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  currentStatus
                    ? currentStatus.clean
                      ? "bg-emerald-500"
                      : "bg-amber-500"
                    : "bg-muted-foreground/40",
                )}
              />
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {actionMutation.isPending
                  ? "Running git..."
                  : currentStatus
                    ? formatGitSummary(currentStatus)
                    : "Loading..."}
              </span>
            </div>
            <div className="mt-2">
              <GitBranchPopover
                branches={branches}
                branchFilter={branchFilter}
                currentBranch={currentStatus?.branch}
                loading={branchesQuery.isFetching && !branchesQuery.data}
                locked={locked}
                newBranchName={newBranchName}
                onBranchFilterChange={setBranchFilter}
                onCheckout={(branch) => {
                  if (window.confirm(`Switch to ${branch}?`)) {
                    actionMutation.mutate({ action: "checkout", branch })
                  }
                }}
                onCreateBranch={() =>
                  actionMutation.mutate({
                    action: "createBranch",
                    branch: newBranchName.trim(),
                  })
                }
                onNewBranchNameChange={setNewBranchName}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon-sm"
              title="Refresh git"
              type="button"
              variant="ghost"
              onClick={refreshGit}
            >
              <RefreshCw
                className={cn(
                  (actionMutation.isPending ||
                    diffQuery.isFetching ||
                    historyQuery.isFetching) &&
                    "animate-spin",
                )}
              />
            </Button>
            {onClose ? (
              <Button
                size="icon-sm"
                title="Close git panel"
                type="button"
                variant="ghost"
                onClick={onClose}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1">
          <Button
            disabled={locked}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => {
              if (window.confirm("Pull with rebase and autostash?")) {
                actionMutation.mutate({ action: "pull" })
              }
            }}
          >
            <Download />
            Pull
          </Button>
          <Button
            disabled={locked}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => {
              if (window.confirm("Push this branch?")) {
                actionMutation.mutate({ action: "push" })
              }
            }}
          >
            <Upload />
            Push
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="grid gap-2 p-2">
          <section className="overflow-hidden rounded-lg border bg-card">
            <PanelSectionHeader
              count={changedFiles.length}
              icon={<ListChecks className="size-4 text-muted-foreground" />}
              title="Local Changes"
            />
            <ChangedFilesList
              files={changedFiles}
              loading={statusQuery.isFetching && !currentStatus}
              selectedPath={selectedFilePath}
              onSelect={setSelectedFilePath}
            />
          </section>

          <section className="overflow-hidden rounded-lg border bg-card">
            <PanelSectionHeader
              action={
                selectedFilePath ? (
                  <Button
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() => setSelectedFilePath(null)}
                  >
                    All
                  </Button>
                ) : null
              }
              icon={<FileDiff className="size-4 text-muted-foreground" />}
              subtitle={diffTitle}
              title="Diff Preview"
            />
            <div className="max-h-[42svh] min-h-48 min-w-0 overflow-auto bg-muted/20">
              <GitDiffViewer
                diff={diffQuery.data?.diff ?? ""}
                error={diffQuery.error}
                fallback={diffQuery.data?.stat ?? ""}
                loading={diffQuery.isFetching && !diffText}
              />
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border bg-card">
            <PanelSectionHeader
              icon={
                <GitCommitHorizontal className="size-4 text-muted-foreground" />
              }
              title="Commit"
            />
            <div className="grid gap-2 p-2">
              <Textarea
                className="min-h-20 resize-none text-sm"
                placeholder="Commit message"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <Button
                className="justify-center"
                disabled={
                  locked || !commitMessage.trim() || currentStatus?.clean
                }
                type="button"
                onClick={() => {
                  if (window.confirm("Commit all changed files?")) {
                    actionMutation.mutate({
                      action: "commit",
                      message: commitMessage.trim(),
                    })
                  }
                }}
              >
                <GitCommitHorizontal />
                Commit All
              </Button>
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border bg-card">
            <PanelSectionHeader
              count={commits.length}
              icon={<Clock className="size-4 text-muted-foreground" />}
              title="History"
            />
            <div className="h-80 min-h-44 overflow-hidden">
              <GitHistoryPanel
                commits={commits}
                error={historyQuery.error}
                fetching={historyQuery.isFetching}
                selectedHash={selectedCommitHash}
                onSelect={setSelectedCommitHash}
              />
            </div>
            <div className="min-h-20 border-t p-3 text-xs">
              {selectedCommit ? (
                <div className="grid gap-1">
                  <div className="line-clamp-2 font-medium">
                    {selectedCommit.subject}
                  </div>
                  <div className="truncate font-mono text-muted-foreground">
                    {selectedCommit.hash}
                  </div>
                  <div className="truncate text-muted-foreground">
                    {selectedCommit.authorName || "Unknown author"} ·{" "}
                    {formatGitCommitDate(selectedCommit.authoredAt)}
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground">No commit selected.</div>
              )}
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

function PanelSectionHeader({
  action,
  count,
  icon,
  subtitle,
  title,
}: {
  action?: ReactNode
  count?: number
  icon: ReactNode
  subtitle?: string
  title: string
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 border-b bg-muted/25 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          {subtitle ? (
            <div className="truncate font-mono text-xs text-muted-foreground">
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
      {action ??
        (typeof count === "number" ? (
          <span className="text-xs text-muted-foreground">{count}</span>
        ) : null)}
    </div>
  )
}

function GitBranchPopover({
  branches,
  branchFilter,
  currentBranch,
  loading,
  locked,
  newBranchName,
  onBranchFilterChange,
  onCheckout,
  onCreateBranch,
  onNewBranchNameChange,
}: {
  branches: GitBranchesResponse["branches"]
  branchFilter: string
  currentBranch?: string | null
  loading: boolean
  locked: boolean
  newBranchName: string
  onBranchFilterChange: (value: string) => void
  onCheckout: (branch: string) => void
  onCreateBranch: () => void
  onNewBranchNameChange: (value: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className="max-w-64 justify-start"
            size="sm"
            type="button"
            variant="outline"
          />
        }
      >
        <GitBranch />
        <span className="min-w-0 truncate">{currentBranch ?? "No branch"}</span>
        <ChevronDown className="ml-1 size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-0 p-0" side="bottom">
        <PopoverHeader className="border-b p-3">
          <PopoverTitle>Branches</PopoverTitle>
          <PopoverDescription>
            Current branch: {currentBranch ?? "detached"}
          </PopoverDescription>
        </PopoverHeader>
        <div className="grid gap-2 p-3">
          <Input
            className="h-8"
            placeholder="Find branch"
            value={branchFilter}
            onChange={(event) => onBranchFilterChange(event.target.value)}
          />
        </div>
        <ScrollArea className="max-h-72 border-y">
          <div className="grid gap-1 p-2">
            {branches.map((branch) => (
              <Button
                className="justify-start"
                disabled={locked || branch.current}
                key={branch.name}
                size="sm"
                type="button"
                variant={branch.current ? "secondary" : "ghost"}
                onClick={() => onCheckout(branch.name)}
              >
                {branch.current ? <Check /> : <GitBranch />}
                <span className="min-w-0 truncate">{branch.name}</span>
              </Button>
            ))}
            {!branches.length ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                {loading ? "Loading branches..." : "No branches found."}
              </div>
            ) : null}
          </div>
        </ScrollArea>
        <div className="grid gap-2 p-3">
          <Input
            className="h-8"
            placeholder="New branch"
            value={newBranchName}
            onChange={(event) => onNewBranchNameChange(event.target.value)}
          />
          <Button
            disabled={locked || !newBranchName.trim()}
            size="sm"
            type="button"
            variant="outline"
            onClick={onCreateBranch}
          >
            <Plus />
            Create branch
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ChangedFilesList({
  files,
  loading,
  selectedPath,
  onSelect,
}: {
  files: GitFileStatus[]
  loading: boolean
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  if (loading) {
    return (
      <div className="m-3 rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
        Loading status...
      </div>
    )
  }
  if (!files.length) {
    return (
      <div className="m-3 rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
        Working tree clean.
      </div>
    )
  }
  return (
    <div className="grid gap-1 p-2">
      {files.map((file) => (
        <button
          className={cn(
            "grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted",
            selectedPath === file.path && "bg-muted",
          )}
          key={`${file.status}:${file.path}`}
          type="button"
          onClick={() => onSelect(file.path)}
        >
          <span
            className={cn(
              "rounded-sm px-1 py-0.5 text-center font-mono text-[0.68rem]",
              gitStatusClassName(file.status),
            )}
          >
            {file.status.trim()}
          </span>
          <span className="min-w-0 truncate font-mono">{file.path}</span>
        </button>
      ))}
    </div>
  )
}

function gitStatusClassName(status: string): string {
  if (status.includes("D")) {
    return "bg-red-500/10 text-red-700 dark:text-red-300"
  }
  if (status.includes("A") || status.includes("?")) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (status.includes("R") || status.includes("C")) {
    return "bg-blue-500/10 text-blue-700 dark:text-blue-300"
  }
  return "bg-amber-500/10 text-amber-700 dark:text-amber-300"
}

function filterGitBranches(
  response: GitBranchesResponse | undefined,
  filter: string,
) {
  const normalized = filter.trim().toLocaleLowerCase()
  const branches = response?.branches ?? []
  return normalized
    ? branches.filter((branch) =>
        branch.name.toLocaleLowerCase().includes(normalized),
      )
    : branches
}

function formatGitSummary(status?: GitStatusResponse): string {
  if (!status) {
    return "Git unavailable"
  }
  const parts = [
    status.clean ? "clean" : `${status.changedFiles.length} changed`,
    formatAheadBehind(status),
  ].filter(Boolean)
  return parts.join(" · ")
}

function formatAheadBehind(status: GitStatusResponse): string {
  const parts = []
  if (status.ahead) {
    parts.push(`+${status.ahead}`)
  }
  if (status.behind) {
    parts.push(`-${status.behind}`)
  }
  return parts.join(" ")
}
