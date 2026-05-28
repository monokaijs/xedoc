import type {
  ChatFileChangeMetadata,
  ChatMessageMetadata,
  ChatMessageResponse,
  JsonSerializable,
} from "@/types"
import { ChevronDown, Eye, FileDiff, Loader2, RotateCcw } from "lucide-react"
import { useContext, useMemo } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { FileViewerContext } from "@/components/timeline/file-viewer-context"
import type { FileChangePromptAction } from "@/components/timeline/chat-timeline"

export function FileChangeBlock({
  disabled,
  messages,
  onReview,
  onUndo,
  pending,
}: {
  disabled?: boolean
  messages: ChatMessageResponse[]
  onReview?: (action: FileChangePromptAction) => void
  onUndo?: (action: FileChangePromptAction) => void
  pending?: boolean
}) {
  const summary = useMemo(() => summarizeFileChanges(messages), [messages])
  const openFile = useContext(FileViewerContext)
  const locked =
    disabled ||
    pending ||
    messages.some(
      (message) =>
        message.status === "STREAMING" || message.status === "PENDING",
    )
  const canAct = !locked && summary.entries.length > 0

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border bg-background text-sm">
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileDiff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate font-medium">
              {summary.entries.length
                ? `${fileChangeHeaderVerb(summary.entries)} ${summary.entries.length} ${summary.entries.length === 1 ? "file" : "files"}`
                : "File changes"}
            </div>
            <DiffCountText
              additions={summary.additions}
              deletions={summary.deletions}
            />
          </div>
        </div>
        <div />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            disabled={!canAct || !onUndo}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() =>
              onUndo?.({
                message: summary.message,
                prompt: buildUndoFileChangesPrompt(summary),
              })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Undo
          </Button>
          <Button
            disabled={!canAct || !onReview}
            size="sm"
            type="button"
            variant="outline"
            onClick={() =>
              onReview?.({
                message: summary.message,
                prompt: buildReviewFileChangesPrompt(summary),
              })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <Eye />}
            Review
          </Button>
        </div>
      </div>
      <div className="grid min-w-0 divide-y border-t">
        {summary.entries.length ? (
          summary.entries.map((entry) => (
            <Dialog key={entry.path}>
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/50">
                <button
                  className="min-w-0 truncate text-left font-mono text-xs underline-offset-2 hover:underline"
                  type="button"
                  onClick={() => openFile?.({ path: entry.path })}
                >
                  {entry.path}
                </button>
                <DiffCountText
                  additions={entry.additions}
                  deletions={entry.deletions}
                />
                <DialogTrigger
                  render={<Button size="icon-sm" variant="ghost" />}
                >
                  <ChevronDown className="-rotate-90 size-4 text-muted-foreground" />
                  <span className="sr-only">Open diff</span>
                </DialogTrigger>
              </div>
              <DialogContent className="max-w-5xl">
                <DialogHeader>
                  <DialogTitle>{entry.path}</DialogTitle>
                  <DialogDescription>
                    {entry.action ?? "Edited"} file change reported by Codex.
                  </DialogDescription>
                </DialogHeader>
                <pre className="max-h-[70vh] min-w-0 max-w-full overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">
                  {entry.diff?.trim() ||
                    summary.diff?.trim() ||
                    "No diff body was reported for this file."}
                </pre>
              </DialogContent>
            </Dialog>
          ))
        ) : (
          <div className="px-3 py-2 text-muted-foreground">
            Changes detected.
          </div>
        )}
      </div>
      {summary.statuses.length ? (
        <div className="flex min-w-0 flex-wrap gap-1 border-t px-3 py-2">
          {summary.statuses.map((status) => (
            <Badge key={status} variant="secondary">
              {status}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ActiveFileChangesPanel({
  messages,
}: {
  messages: ChatMessageResponse[]
}) {
  const summary = useMemo(
    () => (messages.length ? summarizeFileChanges(messages) : null),
    [messages],
  )
  if (!summary) {
    return null
  }
  const latestPath = summary.entries.at(-1)?.path

  return (
    <section
      aria-label="Latest file changes"
      aria-live="polite"
      className="border-b bg-background px-3 py-2"
    >
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-muted/20 px-3 py-2 text-sm shadow-sm">
          <FileDiff className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-medium">Latest changes</span>
              <DiffCountText
                additions={summary.additions}
                deletions={summary.deletions}
              />
            </div>
            <div className="min-w-0 truncate text-xs text-muted-foreground">
              {summary.entries.length
                ? `${summary.entries.length} ${summary.entries.length === 1 ? "file" : "files"} changed${latestPath ? `: ${latestPath}` : ""}`
                : "File changes detected"}
            </div>
          </div>
          {summary.statuses.at(-1) ? (
            <Badge className="shrink-0" variant="secondary">
              {summary.statuses.at(-1)}
            </Badge>
          ) : null}
        </div>
      </div>
    </section>
  )
}

type FileChangeEntry = {
  action?: string
  additions: number
  deletions: number
  diff?: string
  path: string
}

type FileChangeSummary = {
  additions: number
  deletions: number
  diff?: string
  entries: FileChangeEntry[]
  message: ChatMessageResponse
  statuses: string[]
}

function summarizeFileChanges(
  messages: ChatMessageResponse[],
): FileChangeSummary {
  const ordered = [...messages].sort(
    (left, right) => left.sequence - right.sequence,
  )
  const entryByPath = new Map<string, FileChangeEntry>()
  const statuses = new Set<string>()
  const diffs: string[] = []

  for (const message of ordered) {
    const metadata = metadataAs<ChatFileChangeMetadata>(message.metadata)
    if (metadata?.status) {
      statuses.add(metadata.status)
    }
    if (metadata?.diff?.trim()) {
      diffs.push(metadata.diff.trim())
    }

    for (const entry of fileChangeEntriesFromMetadata(metadata)) {
      const existing = entryByPath.get(entry.path)
      if (!existing) {
        entryByPath.set(entry.path, entry)
        continue
      }
      entryByPath.set(entry.path, {
        action: mergeFileChangeAction(existing.action, entry.action),
        additions: existing.additions + entry.additions,
        deletions: existing.deletions + entry.deletions,
        diff: mergeDiffText(existing.diff, entry.diff),
        path:
          existing.path.length <= entry.path.length
            ? existing.path
            : entry.path,
      })
    }
  }

  const entries = Array.from(entryByPath.values())
  return {
    additions: entries.reduce((sum, entry) => sum + entry.additions, 0),
    deletions: entries.reduce((sum, entry) => sum + entry.deletions, 0),
    diff: mergeDiffText(...diffs),
    entries,
    message: ordered.at(-1) ?? messages[0],
    statuses: Array.from(statuses),
  }
}

function fileChangeEntriesFromMetadata(
  metadata?: ChatFileChangeMetadata,
): FileChangeEntry[] {
  if (!metadata) {
    return []
  }

  const diffEntries = entriesFromUnifiedDiff(metadata.diff)
  const changeEntries = entriesFromChangeObjects(metadata.changes)

  if (changeEntries.length) {
    return [
      ...changeEntries.map((entry) => {
        const diffEntry = diffEntries.find((candidate) =>
          representsSamePath(candidate.path, entry.path),
        )
        return diffEntry
          ? {
              ...entry,
              additions: entry.additions || diffEntry.additions,
              deletions: entry.deletions || diffEntry.deletions,
              diff: diffEntry.diff,
            }
          : entry
      }),
      ...diffEntries.filter(
        (entry) =>
          !changeEntries.some((candidate) =>
            representsSamePath(candidate.path, entry.path),
          ),
      ),
    ]
  }

  if (diffEntries.length) {
    return diffEntries
  }

  const paths = metadata.paths ?? []
  if (!paths.length) {
    return []
  }

  const additions = metadata.additions ?? 0
  const deletions = metadata.deletions ?? 0
  return paths.map((path, index) => ({
    action: "Edited",
    additions: paths.length === 1 || index === 0 ? additions : 0,
    deletions: paths.length === 1 || index === 0 ? deletions : 0,
    path,
  }))
}

function entriesFromChangeObjects(
  changes?: JsonSerializable[],
): FileChangeEntry[] {
  return (changes ?? []).reduce<FileChangeEntry[]>((entries, change) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      return entries
    }
    const object = change as Record<string, unknown>
    const path = firstString(
      object.path,
      object.filePath,
      object.file,
      object.name,
    )
    if (!path) {
      return entries
    }
    entries.push({
      action: titleCase(
        firstString(object.action, object.kind, object.type) ?? "Edited",
      ),
      additions: readNumberish(object.additions),
      deletions: readNumberish(object.deletions),
      path,
    })
    return entries
  }, [])
}

function entriesFromUnifiedDiff(diff?: string): FileChangeEntry[] {
  const trimmed = diff?.trim()
  if (!trimmed) {
    return []
  }
  const chunks = splitUnifiedDiff(trimmed)
  return chunks.reduce<FileChangeEntry[]>((entries, chunk) => {
    const lines = chunk.split("\n")
    const path = pathFromDiffLines(lines)
    if (!path) {
      return entries
    }
    entries.push({
      action: actionFromDiffLines(lines),
      additions: lines.filter(
        (line) => line.startsWith("+") && !line.startsWith("+++"),
      ).length,
      deletions: lines.filter(
        (line) => line.startsWith("-") && !line.startsWith("---"),
      ).length,
      diff: chunk,
      path,
    })
    return entries
  }, [])
}

function splitUnifiedDiff(diff: string): string[] {
  const lines = diff.split("\n")
  const chunks: string[][] = []
  let current: string[] = []

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length) {
      chunks.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length) {
    chunks.push(current)
  }
  return chunks.map((chunk) => chunk.join("\n").trim()).filter(Boolean)
}

function pathFromDiffLines(lines: string[]): string | null {
  for (const prefix of ["+++ ", "--- "]) {
    for (const line of lines) {
      if (!line.startsWith(prefix)) {
        continue
      }
      const path = normalizeDiffPath(line.slice(prefix.length))
      if (path && path !== "/dev/null") {
        return path
      }
    }
  }

  for (const line of lines) {
    if (!line.startsWith("diff --git ")) {
      continue
    }
    const parts = line.split(/\s+/)
    const path = normalizeDiffPath(parts[3] ?? parts[2] ?? "")
    if (path) {
      return path
    }
  }

  return null
}

function actionFromDiffLines(lines: string[]): string {
  if (
    lines.some(
      (line) => line.startsWith("new file mode ") || line === "--- /dev/null",
    )
  ) {
    return "Created"
  }
  if (
    lines.some(
      (line) =>
        line.startsWith("deleted file mode ") || line === "+++ /dev/null",
    )
  ) {
    return "Deleted"
  }
  if (
    lines.some(
      (line) =>
        line.startsWith("rename from ") || line.startsWith("rename to "),
    )
  ) {
    return "Renamed"
  }
  return "Edited"
}

function normalizeDiffPath(path: string): string {
  const trimmed = path.trim().replace(/^"|"$/g, "")
  return trimmed.startsWith("a/") || trimmed.startsWith("b/")
    ? trimmed.slice(2)
    : trimmed
}

function fileChangeHeaderVerb(entries: FileChangeEntry[]): string {
  const actions = new Set(entries.map((entry) => entry.action ?? "Edited"))
  return actions.size === 1 ? (Array.from(actions)[0] ?? "Edited") : "Edited"
}

function buildReviewFileChangesPrompt(summary: FileChangeSummary): string {
  return [
    "Review the changes from the latest completed editing turn.",
    "Look for bugs, regressions, missed requirements, and risky assumptions. Do not modify files unless I explicitly ask.",
    "",
    "Changed files:",
    ...summary.entries.map(
      (entry) => `- ${entry.path} (+${entry.additions} -${entry.deletions})`,
    ),
  ].join("\n")
}

function buildUndoFileChangesPrompt(summary: FileChangeSummary): string {
  return [
    "Undo the changes from the latest completed editing turn.",
    "Revert only the files listed below. Preserve unrelated user edits and stop with an explanation if the reverse patch cannot be applied cleanly.",
    "",
    "Target files:",
    ...summary.entries.map(
      (entry) => `- ${entry.path} (+${entry.additions} -${entry.deletions})`,
    ),
  ].join("\n")
}

function DiffCountText({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}) {
  if (!additions && !deletions) {
    return null
  }
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-xs">
      <span className="text-emerald-600 dark:text-emerald-400">
        +{additions}
      </span>
      <span className="mx-1 text-muted-foreground"> </span>
      <span className="text-red-600 dark:text-red-400">-{deletions}</span>
    </span>
  )
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function readNumberish(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function titleCase(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return "Edited"
  }
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
}

function representsSamePath(left: string, right: string): boolean {
  return normalizePathIdentity(left) === normalizePathIdentity(right)
}

function normalizePathIdentity(path: string): string {
  return normalizeDiffPath(path).replace(/\\/g, "/").replace(/^\.\//, "")
}

function mergeFileChangeAction(left?: string, right?: string): string {
  if (!left) {
    return right ?? "Edited"
  }
  if (!right || left === right) {
    return left
  }
  if (left === "Created" || right === "Created") {
    return "Created"
  }
  if (left === "Deleted" || right === "Deleted") {
    return "Deleted"
  }
  if (left === "Renamed" || right === "Renamed") {
    return "Renamed"
  }
  return "Edited"
}

function mergeDiffText(
  ...values: Array<string | undefined>
): string | undefined {
  const parts = values
    .map((value) => value?.trim())
    .filter((value): value is string => !!value)
  if (!parts.length) {
    return undefined
  }
  return Array.from(new Set(parts)).join("\n\n")
}

function metadataAs<TMetadata extends ChatMessageMetadata>(
  metadata: ChatMessageResponse["metadata"],
): TMetadata | undefined {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as TMetadata)
    : undefined
}
