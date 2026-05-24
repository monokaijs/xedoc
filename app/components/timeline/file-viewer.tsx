import type { WorkspaceFileResponse } from "@/types"
import { useQuery } from "@tanstack/react-query"
import { FileCode, Loader2 } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { readChatWorkspaceFile } from "@/lib/api"
import { highlightCode } from "@/lib/highlight"
import type { WebSession } from "@/lib/session-storage"
import { cn } from "@/lib/utils"
import type { FileViewerTarget } from "@/components/timeline/file-viewer-context"

export function FileViewerDialog({
  chatId,
  onClose,
  session,
  target,
}: {
  chatId: string
  onClose: () => void
  session: WebSession
  target: FileViewerTarget | null
}) {
  const query = useQuery({
    enabled: !!target,
    queryKey: ["workspace-file", chatId, target?.path, target?.line ?? null],
    queryFn: () =>
      readChatWorkspaceFile(
        session,
        chatId,
        target!.path,
        target!.line ?? null,
      ),
    retry: false,
  })

  return (
    <Dialog open={!!target} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col overflow-hidden p-0">
        <DialogHeader className="gap-1 px-4 pb-2 pt-4">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <FileCode className="size-4 shrink-0" />
            <span className="min-w-0 truncate">
              {query.data?.relativePath ?? target?.path ?? "File"}
            </span>
          </DialogTitle>
          <DialogDescription className="truncate">
            {fileViewerDescription(query.data)}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 border-t">
          {query.isLoading ? (
            <div className="grid h-72 place-items-center text-sm text-muted-foreground">
              <Loader2 className="mb-2 size-5 animate-spin" />
              Loading file...
            </div>
          ) : query.error ? (
            <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {query.error.message}
            </div>
          ) : query.data ? (
            <WorkspaceFileContent file={query.data} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function WorkspaceFileContent({ file }: { file: WorkspaceFileResponse }) {
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const lines = useMemo(() => {
    const content = file.content ?? ""
    return content.split(/\r?\n/)
  }, [file.content])
  useEffect(() => {
    if (!file.line) {
      return
    }
    const element = lineRefs.current[file.line]
    element?.scrollIntoView({ block: "center" })
  }, [file.line, lines.length])

  if (file.isBinary) {
    return (
      <div className="m-4 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        Binary files are not displayed.
      </div>
    )
  }

  return (
    <ScrollArea className="h-[70vh]">
      <div className="min-w-0 overflow-x-auto bg-background p-3">
        <pre className="min-w-max font-mono text-xs leading-5">
          {lines.map((line, index) => {
            const lineNumber = index + 1
            const selected = file.line === lineNumber
            return (
              <div
                className={cn(
                  "grid grid-cols-[3.5rem_minmax(0,1fr)] rounded-sm",
                  selected && "bg-primary/10",
                )}
                key={lineNumber}
                ref={(element) => {
                  lineRefs.current[lineNumber] = element
                }}
              >
                <span className="select-none pr-3 text-right text-muted-foreground">
                  {lineNumber}
                </span>
                <code
                  className="whitespace-pre"
                  dangerouslySetInnerHTML={{
                    __html: highlightCode(line || " ", file.language),
                  }}
                />
              </div>
            )
          })}
        </pre>
        {file.truncated ? (
          <div className="mt-3 rounded-md border bg-muted/35 p-2 text-xs text-muted-foreground">
            File preview truncated at 1 MB.
          </div>
        ) : null}
      </div>
    </ScrollArea>
  )
}

function fileViewerDescription(file?: WorkspaceFileResponse): string {
  if (!file) {
    return "Read-only workspace file viewer."
  }
  const parts = [
    formatFileSize(file.size),
    file.language,
    file.line ? `line ${file.line}` : null,
  ].filter(Boolean)
  return parts.join(" · ")
}

function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`
  }
  return `${size} B`
}
