import { File as FileIcon } from "lucide-react"
import { useMemo } from "react"
import { highlightCode } from "@/lib/highlight"
import { cn } from "@/lib/utils"
import { readError } from "@/screens/chat-runtime-utils"
import "highlight.js/styles/github.css"

type DiffFile = {
  hunks: DiffHunk[]
  language: string | null
  meta: string[]
  path: string
}

type DiffHunk = {
  header: string
  lines: DiffLine[]
}

type DiffLine = {
  content: string
  newNumber: number | null
  oldNumber: number | null
  type: "add" | "context" | "delete" | "meta"
}

export function GitDiffViewer({
  diff,
  error,
  fallback,
  loading,
}: {
  diff: string
  error: unknown
  fallback: string
  loading: boolean
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])

  if (error) {
    return (
      <div className="p-3 font-mono text-xs text-destructive">
        {readError(error)}
      </div>
    )
  }
  if (loading) {
    return (
      <div className="p-3 font-mono text-xs text-muted-foreground">
        Loading diff...
      </div>
    )
  }
  if (!files.length) {
    return (
      <pre className="min-h-full min-w-0 overflow-auto p-3 font-mono text-xs leading-5 text-muted-foreground">
        {fallback.trim() || "No tracked diff."}
      </pre>
    )
  }

  return (
    <div className="min-w-max divide-y">
      {files.map((file) => (
        <section key={file.path} className="bg-background">
          <div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2 backdrop-blur">
            <div className="flex min-w-0 items-center gap-2">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs font-medium">
                {file.path}
              </span>
            </div>
            {file.meta.length ? (
              <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[0.68rem] text-muted-foreground">
                {file.meta.slice(0, 3).map((line) => (
                  <span className="truncate" key={line}>
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="py-1 font-mono text-xs leading-5">
            {file.hunks.map((hunk, index) => (
              <div key={`${file.path}:${index}`}>
                <div className="grid grid-cols-[4.5rem_1.25rem_minmax(24rem,1fr)] border-y bg-muted/70 text-[0.68rem] text-muted-foreground">
                  <div className="border-r px-2 py-1 text-right">line</div>
                  <div />
                  <div className="whitespace-pre px-2 py-1">{hunk.header}</div>
                </div>
                {hunk.lines.map((line, lineIndex) => (
                  <DiffViewerLine
                    fileLanguage={file.language}
                    key={`${file.path}:${index}:${lineIndex}`}
                    line={line}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function DiffViewerLine({
  fileLanguage,
  line,
}: {
  fileLanguage: string | null
  line: DiffLine
}) {
  const prefix =
    line.type === "add"
      ? "+"
      : line.type === "delete"
        ? "-"
        : line.type === "meta"
          ? "\\"
          : " "
  const lineNumber =
    line.type === "delete" ? line.oldNumber : (line.newNumber ?? line.oldNumber)
  const highlighted =
    line.type === "meta"
      ? escapeHtml(line.content)
      : highlightCode(line.content || " ", fileLanguage)

  return (
    <div
      className={cn(
        "grid grid-cols-[4.5rem_1.25rem_minmax(24rem,1fr)] border-l-2",
        line.type === "add" &&
          "border-l-emerald-500 bg-emerald-500/10 text-emerald-950 dark:text-emerald-50",
        line.type === "delete" &&
          "border-l-red-500 bg-red-500/10 text-red-950 dark:text-red-50",
        line.type === "context" && "border-l-transparent bg-background",
        line.type === "meta" &&
          "border-l-transparent bg-muted/40 text-muted-foreground",
      )}
    >
      <div className="select-none border-r px-2 text-right text-[0.68rem] text-muted-foreground">
        {lineNumber ?? ""}
      </div>
      <div className="select-none px-2 text-center text-muted-foreground">
        {prefix}
      </div>
      <div
        className="whitespace-pre px-2"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  )
}

function parseUnifiedDiff(diff: string): DiffFile[] {
  const trimmed = diff.trim()
  if (!trimmed) {
    return []
  }
  return splitUnifiedDiffFiles(trimmed)
    .map(parseUnifiedDiffFile)
    .filter((file): file is DiffFile => !!file)
}

function splitUnifiedDiffFiles(diff: string): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && current.length) {
      chunks.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length) {
    chunks.push(current)
  }
  return chunks
}

function parseUnifiedDiffFile(lines: string[]): DiffFile | null {
  const path = diffPathFromLines(lines)
  if (!path) {
    return null
  }
  const file: DiffFile = {
    hunks: [],
    language: languageFromPath(path),
    meta: [],
    path,
  }
  let currentHunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const range = parseHunkRange(line)
      oldLine = range.oldStart
      newLine = range.newStart
      currentHunk = { header: line, lines: [] }
      file.hunks.push(currentHunk)
      continue
    }

    if (!currentHunk) {
      if (
        !line.startsWith("diff --git ") &&
        !line.startsWith("--- ") &&
        !line.startsWith("+++ ")
      ) {
        file.meta.push(line)
      }
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({
        content: line.slice(1),
        newNumber: newLine,
        oldNumber: null,
        type: "add",
      })
      newLine += 1
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({
        content: line.slice(1),
        newNumber: null,
        oldNumber: oldLine,
        type: "delete",
      })
      oldLine += 1
    } else if (line.startsWith("\\")) {
      currentHunk.lines.push({
        content: line,
        newNumber: null,
        oldNumber: null,
        type: "meta",
      })
    } else {
      currentHunk.lines.push({
        content: line.startsWith(" ") ? line.slice(1) : line,
        newNumber: newLine,
        oldNumber: oldLine,
        type: "context",
      })
      oldLine += 1
      newLine += 1
    }
  }

  return file.hunks.length ? file : null
}

function diffPathFromLines(lines: string[]): string | null {
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
  const header = lines.find((line) => line.startsWith("diff --git "))
  const parts = header?.split(/\s+/) ?? []
  return normalizeDiffPath(parts[3] ?? parts[2] ?? "")
}

function normalizeDiffPath(path: string): string | null {
  const trimmed = path.trim().replace(/^"|"$/g, "")
  if (!trimmed) {
    return null
  }
  return trimmed.replace(/^[ab]\//, "")
}

function parseHunkRange(header: string): {
  oldStart: number
  newStart: number
} {
  const match = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  return {
    newStart: Number(match?.[2] ?? 0),
    oldStart: Number(match?.[1] ?? 0),
  }
}

function languageFromPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLocaleLowerCase()
  switch (extension) {
    case "bash":
    case "sh":
      return "bash"
    case "css":
      return "css"
    case "go":
      return "go"
    case "htm":
    case "html":
    case "svg":
    case "xml":
      return "xml"
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript"
    case "json":
      return "json"
    case "md":
    case "mdx":
      return "markdown"
    case "py":
      return "python"
    case "rs":
      return "rust"
    case "sql":
      return "sql"
    case "ts":
    case "tsx":
      return "typescript"
    case "yaml":
    case "yml":
      return "yaml"
    default:
      return null
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
