import type { GitCommit } from "@/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { readError } from "@/screens/chat-runtime-utils"

export function GitHistoryPanel({
  commits,
  error,
  fetching,
  selectedHash,
  onSelect,
}: {
  commits: GitCommit[]
  error: unknown
  fetching: boolean
  selectedHash: string | null
  onSelect: (hash: string) => void
}) {
  if (error) {
    return (
      <div className="p-3 text-xs text-destructive">{readError(error)}</div>
    )
  }
  if (fetching && !commits.length) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Loading history...
      </div>
    )
  }
  if (!commits.length) {
    return (
      <div className="p-3 text-xs text-muted-foreground">No commits found.</div>
    )
  }
  return (
    <ScrollArea className="h-full min-h-0">
      <div className="grid gap-1 p-2">
        {commits.map((commit) => (
          <button
            className={cn(
              "grid gap-1 rounded-md px-2 py-2 text-left outline-none hover:bg-muted focus-visible:bg-muted",
              selectedHash === commit.hash && "bg-muted",
            )}
            key={commit.hash}
            type="button"
            onClick={() => onSelect(commit.hash)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {commit.subject}
              </span>
              <span className="shrink-0 font-mono text-[0.68rem] text-muted-foreground">
                {commit.shortHash}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-[0.68rem] text-muted-foreground">
              <span className="min-w-0 truncate">
                {commit.authorName || "Unknown author"}
              </span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">
                {formatGitCommitDate(commit.authoredAt)}
              </span>
            </div>
            {commit.refs.length ? (
              <div className="flex min-w-0 flex-wrap gap-1">
                {commit.refs.slice(0, 3).map((ref) => (
                  <span
                    className="max-w-full truncate rounded bg-secondary px-1.5 py-0.5 text-[0.65rem] text-secondary-foreground"
                    key={ref}
                  >
                    {ref}
                  </span>
                ))}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    </ScrollArea>
  )
}

export function formatGitCommitDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown date"
  }
  return date.toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  })
}
