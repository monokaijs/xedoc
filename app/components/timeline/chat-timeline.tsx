import type {
  ChatApprovalMetadata,
  ChatCommandMetadata,
  ChatErrorMetadata,
  ChatFileChangeMetadata,
  ChatMessageAttachment,
  ChatMessageMetadata,
  ChatMessageResponse,
  ChatPlanMetadata,
  ChatUserInputMetadata,
  ChatUserInputQuestion,
  JsonSerializable,
  MessagePageResponse,
  ServerRequestResponseRequest,
  WorkspaceFileResponse,
} from "@/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  Eye,
  FileCode,
  FileDiff,
  ListChecks,
  Loader2,
  LockKeyhole,
  PencilLine,
  RotateCcw,
  Terminal,
  UserRound,
} from "lucide-react"
import type { ReactNode } from "react"
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import "highlight.js/styles/github.css"
import { toast } from "sonner"
import { StatusBadge } from "@/components/status-badge"
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
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { appendMessage, readChatWorkspaceFile, respondToServerRequest } from "@/lib/api"
import { highlightCode } from "@/lib/highlight"
import type { WebSession } from "@/lib/session-storage"
import { cn } from "@/lib/utils"

type FileViewerTarget = {
  line?: number | null
  path: string
}

const FileViewerContext = createContext<((target: FileViewerTarget) => void) | null>(
  null,
)

export function ChatTimeline({
  chatId,
  hiddenMessageIds,
  messages,
  onImplementPlan,
  onRevisePlan,
  onReviewFileChanges,
  onUndoFileChanges,
  fileChangeActionDisabled,
  fileChangeActionPending,
  planActionDisabled,
  planActionPending,
  session,
}: {
  chatId: string
  fileChangeActionDisabled?: boolean
  fileChangeActionPending?: boolean
  hiddenMessageIds?: string[]
  messages: ChatMessageResponse[]
  onReviewFileChanges?: (action: FileChangePromptAction) => void
  onUndoFileChanges?: (action: FileChangePromptAction) => void
  onImplementPlan?: (action: ProposedPlanAction) => void
  onRevisePlan?: (action: ProposedPlanRevisionAction) => void
  planActionDisabled?: boolean
  planActionPending?: boolean
  session: WebSession
}) {
  const hiddenIds = useMemo(
    () => new Set(hiddenMessageIds ?? []),
    [hiddenMessageIds],
  )
  const timeline = useMemo(
    () =>
      projectTimelineMessages(messages).filter(
        (message) => !hiddenIds.has(message.id),
      ),
    [hiddenIds, messages],
  )
  const entries = useMemo(() => groupTimelineEntries(timeline), [timeline])
  const latestProposedPlanMessageId = useMemo(
    () => latestProposedPlanMessageIdFrom(timeline),
    [timeline],
  )
  const [fileViewerTarget, setFileViewerTarget] =
    useState<FileViewerTarget | null>(null)

  return (
    <FileViewerContext.Provider value={setFileViewerTarget}>
      {entries.map((entry) => (
        <TimelineEntryRow
          chatId={chatId}
          entry={entry}
          fileChangeActionDisabled={fileChangeActionDisabled}
          fileChangeActionPending={fileChangeActionPending}
          key={entry.id}
          latestProposedPlanMessageId={latestProposedPlanMessageId}
          onImplementPlan={onImplementPlan}
          onRevisePlan={onRevisePlan}
          onReviewFileChanges={onReviewFileChanges}
          onUndoFileChanges={onUndoFileChanges}
          planActionDisabled={planActionDisabled}
          planActionPending={planActionPending}
          session={session}
        />
      ))}
      <FileViewerDialog
        chatId={chatId}
        session={session}
        target={fileViewerTarget}
        onClose={() => setFileViewerTarget(null)}
      />
    </FileViewerContext.Provider>
  )
}

export function ChatComposerContextPanel({
  chatId,
  messages,
  session,
}: {
  chatId: string
  messages: ChatMessageResponse[]
  session: WebSession
}) {
  const context = useMemo(() => findStickyChatContext(messages), [messages])
  if (!context.pendingRequest) {
    return null
  }
  return (
    <div className="grid min-w-0 gap-1.5 overflow-hidden border-b bg-background px-3 py-2">
      <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-1.5 overflow-hidden">
        <TimelineContent
          chatId={chatId}
          compact
          message={context.pendingRequest}
          session={session}
        />
      </div>
    </div>
  )
}

type TimelineEntry =
  | {
      id: string
      message: ChatMessageResponse
      type: "user"
    }
  | {
      id: string
      messages: ChatMessageResponse[]
      type: "codex"
    }

type CodexRenderItem =
  | {
      id: string
      message: ChatMessageResponse
      type: "message"
    }
  | {
      id: string
      messages: ChatMessageResponse[]
      type: "toolBurst"
    }
  | {
      id: string
      messages: ChatMessageResponse[]
      type: "previousActions"
    }
  | {
      id: string
      messages: ChatMessageResponse[]
      type: "fileChanges"
    }

export type ProposedPlanAction = {
  message: ChatMessageResponse
  planBody: string
}

export type ProposedPlanRevisionAction = ProposedPlanAction & {
  feedback: string
}

export type FileChangePromptAction = {
  message: ChatMessageResponse
  prompt: string
}

type PlanActionHandlers = {
  latestProposedPlanMessageId?: string | null
  onImplementPlan?: (action: ProposedPlanAction) => void
  onRevisePlan?: (action: ProposedPlanRevisionAction) => void
  planActionDisabled?: boolean
  planActionPending?: boolean
}

type FileChangeActionHandlers = {
  fileChangeActionDisabled?: boolean
  fileChangeActionPending?: boolean
  onReviewFileChanges?: (action: FileChangePromptAction) => void
  onUndoFileChanges?: (action: FileChangePromptAction) => void
}

function TimelineEntryRow({
  chatId,
  entry,
  fileChangeActionDisabled,
  fileChangeActionPending,
  latestProposedPlanMessageId,
  onImplementPlan,
  onRevisePlan,
  onReviewFileChanges,
  onUndoFileChanges,
  planActionDisabled,
  planActionPending,
  session,
}: {
  chatId: string
  entry: TimelineEntry
  session: WebSession
} & PlanActionHandlers &
  FileChangeActionHandlers) {
  if (entry.type === "user") {
    return <UserMessageRow message={entry.message} />
  }

  return (
    <CodexTurnRow
      chatId={chatId}
      fileChangeActionDisabled={fileChangeActionDisabled}
      fileChangeActionPending={fileChangeActionPending}
      latestProposedPlanMessageId={latestProposedPlanMessageId}
      messages={entry.messages}
      onImplementPlan={onImplementPlan}
      onRevisePlan={onRevisePlan}
      onReviewFileChanges={onReviewFileChanges}
      onUndoFileChanges={onUndoFileChanges}
      planActionDisabled={planActionDisabled}
      planActionPending={planActionPending}
      session={session}
    />
  )
}

function CodexTurnRow({
  chatId,
  fileChangeActionDisabled,
  fileChangeActionPending,
  latestProposedPlanMessageId,
  messages,
  onImplementPlan,
  onRevisePlan,
  onReviewFileChanges,
  onUndoFileChanges,
  planActionDisabled,
  planActionPending,
  session,
}: {
  chatId: string
  messages: ChatMessageResponse[]
  session: WebSession
} & PlanActionHandlers &
  FileChangeActionHandlers) {
  const displayItems = useMemo(() => projectCodexRenderItems(messages), [messages])
  const status = messages.reduce<ChatMessageResponse["status"] | null>(
    (current, message) => {
      if (message.status === "FAILED") {
        return "FAILED"
      }
      if (message.status === "STREAMING") {
        return current === "FAILED" ? current : "STREAMING"
      }
      if (message.status === "PENDING") {
        return current === "FAILED" || current === "STREAMING"
          ? current
          : "PENDING"
      }
      return current
    },
    null,
  )

  return (
    <article className="mx-auto flex w-full min-w-0 max-w-full justify-start overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="mb-1 flex items-center gap-2 pl-1">
          <span className="text-xs font-medium text-muted-foreground">
            Codex
          </span>
          {status ? <StatusBadge status={status} /> : null}
        </div>
        <div className="grid min-w-0 gap-2">
          {displayItems.map((item) => (
            <CodexRenderItemContent
              chatId={chatId}
              fileChangeActionDisabled={fileChangeActionDisabled}
              fileChangeActionPending={fileChangeActionPending}
              item={item}
              key={item.id}
              latestProposedPlanMessageId={latestProposedPlanMessageId}
              onImplementPlan={onImplementPlan}
              onRevisePlan={onRevisePlan}
              onReviewFileChanges={onReviewFileChanges}
              onUndoFileChanges={onUndoFileChanges}
              planActionDisabled={planActionDisabled}
              planActionPending={planActionPending}
              session={session}
            />
          ))}
        </div>
      </div>
    </article>
  )
}

function CodexRenderItemContent({
  chatId,
  fileChangeActionDisabled,
  fileChangeActionPending,
  item,
  latestProposedPlanMessageId,
  onImplementPlan,
  onRevisePlan,
  onReviewFileChanges,
  onUndoFileChanges,
  planActionDisabled,
  planActionPending,
  session,
}: {
  chatId: string
  item: CodexRenderItem
  session: WebSession
} & PlanActionHandlers &
  FileChangeActionHandlers) {
  if (item.type === "toolBurst") {
    return <ToolBurstBlock messages={item.messages} />
  }
  if (item.type === "previousActions") {
    return <PreviousActionsBlock messages={item.messages} />
  }
  if (item.type === "fileChanges") {
    return (
      <FileChangeBlock
        disabled={fileChangeActionDisabled}
        messages={item.messages}
        pending={fileChangeActionPending}
        onReview={onReviewFileChanges}
        onUndo={onUndoFileChanges}
      />
    )
  }
  return (
    <TimelineContent
      chatId={chatId}
      fileChangeActionDisabled={fileChangeActionDisabled}
      fileChangeActionPending={fileChangeActionPending}
      latestProposedPlanMessageId={latestProposedPlanMessageId}
      message={item.message}
      onImplementPlan={onImplementPlan}
      onRevisePlan={onRevisePlan}
      onReviewFileChanges={onReviewFileChanges}
      onUndoFileChanges={onUndoFileChanges}
      planActionDisabled={planActionDisabled}
      planActionPending={planActionPending}
      session={session}
    />
  )
}

function UserMessageRow({ message }: { message: ChatMessageResponse }) {
  const attachments = messageAttachments(message)
  const imageTaggedParts = useMemo(
    () => splitImageTags(message.content),
    [message.content],
  )
  const textContent = textFromImageTaggedParts(imageTaggedParts)
  const imageItems = useMemo(
    () => userImagePreviewItems(imageTaggedParts, attachments),
    [attachments, imageTaggedParts],
  )
  const fileAttachments = attachments.filter(
    (attachment) => attachment.kind === "file",
  )
  const [previewImage, setPreviewImage] = useState<UserImagePreviewItem | null>(
    null,
  )
  const hasTextBubble = textContent || fileAttachments.length

  return (
    <article className="flex min-w-0 max-w-full justify-end overflow-hidden">
      <div className="flex min-w-0 max-w-[84%] flex-col items-end gap-2 overflow-hidden">
        {imageItems.length ? (
          <div className="flex max-w-full flex-wrap justify-end gap-1.5">
            {imageItems.map((item) => (
              <button
                className="size-16 overflow-hidden rounded-lg border bg-muted outline-none ring-offset-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                key={item.id}
                title={item.name}
                type="button"
                onClick={() => setPreviewImage(item)}
              >
                <img
                  alt={item.name}
                  className="size-full object-cover"
                  loading="lazy"
                  src={item.src}
                />
              </button>
            ))}
          </div>
        ) : null}
        {hasTextBubble ? (
          <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-card px-3 py-2 text-sm leading-6 text-card-foreground">
            <div className="mb-1 flex items-center gap-2 text-muted-foreground">
              <UserRound className="size-3.5 opacity-80" />
              <span className="text-xs font-medium">You</span>
            </div>
            {textContent ? (
              <div className="whitespace-pre-wrap break-words">{textContent}</div>
            ) : null}
            {fileAttachments.length ? (
              <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
                {fileAttachments.map((attachment) => (
                  <span
                    className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/35 px-2 py-1 text-xs text-muted-foreground"
                    key={attachment.id}
                  >
                    <FileCode className="size-3.5 shrink-0 opacity-80" />
                    <span className="min-w-0 truncate">{attachment.path}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog
        open={!!previewImage}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewImage(null)
          }
        }}
      >
        <DialogContent className="flex h-[min(90vh,900px)] w-[min(92vw,1000px)] max-w-none flex-col overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>{previewImage?.name ?? "Image preview"}</DialogTitle>
            <DialogDescription>Full size image preview.</DialogDescription>
          </DialogHeader>
          {previewImage ? (
            <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-2">
              <img
                alt={previewImage.name}
                className="max-h-full max-w-full object-contain"
                src={previewImage.src}
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </article>
  )
}

function TimelineContent({
  chatId,
  compact,
  fileChangeActionDisabled,
  fileChangeActionPending,
  latestProposedPlanMessageId,
  message,
  onImplementPlan,
  onRevisePlan,
  onReviewFileChanges,
  onUndoFileChanges,
  planActionDisabled,
  planActionPending,
  session,
}: {
  chatId: string
  compact?: boolean
  message: ChatMessageResponse
  session: WebSession
} & PlanActionHandlers &
  FileChangeActionHandlers) {
  switch (message.kind) {
    case "CHAT":
      return message.content.trim() ? (
        <AssistantChatContent
          latestProposedPlanMessageId={latestProposedPlanMessageId}
          message={message}
          onImplementPlan={onImplementPlan}
          onRevisePlan={onRevisePlan}
          planActionDisabled={planActionDisabled}
          planActionPending={planActionPending}
        />
      ) : message.status === "STREAMING" || message.status === "PENDING" ? (
        <ProcessingDots />
      ) : null
    case "THINKING":
      return <ThinkingBlock message={message} />
    case "PLAN":
      return (
        <PlanBlock
          metadata={metadataAs<ChatPlanMetadata>(message.metadata)}
          message={message}
          latestProposedPlanMessageId={latestProposedPlanMessageId}
          onImplementPlan={onImplementPlan}
          onRevisePlan={onRevisePlan}
          planActionDisabled={planActionDisabled}
          planActionPending={planActionPending}
        />
      )
    case "COMMAND_EXECUTION":
      return <CommandBlock metadata={metadataAs<ChatCommandMetadata>(message.metadata)} />
    case "FILE_CHANGE":
      return (
        <FileChangeBlock
          disabled={fileChangeActionDisabled}
          messages={[message]}
          pending={fileChangeActionPending}
          onReview={onReviewFileChanges}
          onUndo={onUndoFileChanges}
        />
      )
    case "APPROVAL":
      return (
        <ApprovalBlock
          chatId={chatId}
          compact={compact}
          message={message}
          metadata={metadataAs<ChatApprovalMetadata>(message.metadata)}
          session={session}
        />
      )
    case "USER_INPUT_PROMPT":
      return (
        <UserInputBlock
          chatId={chatId}
          compact={compact}
          message={message}
          metadata={metadataAs<ChatUserInputMetadata>(message.metadata)}
          session={session}
        />
      )
    case "ERROR":
      return <ErrorBlock metadata={metadataAs<ChatErrorMetadata>(message.metadata)} text={message.content} />
    case "TOOL_ACTIVITY":
    default:
      return <SystemText text={message.content} />
  }
}

export function AssistantMarkdown({ text }: { text: string }) {
  const openFile = useContext(FileViewerContext)
  return (
    <div className="min-w-0 max-w-full overflow-hidden break-words px-1 text-sm leading-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, className, href, ...props }) => {
            const target = parseLocalFileReference(href ?? "")
            return target && openFile ? (
              <button
                className={cn(
                  "inline min-w-0 break-words text-left underline underline-offset-2",
                  className,
                )}
                type="button"
                onClick={() => openFile(target)}
              >
                {children}
              </button>
            ) : (
              <a
                className={cn("underline underline-offset-2", className)}
                href={href}
                rel="noreferrer"
                target="_blank"
                {...props}
              >
                {children}
              </a>
            )
          },
          blockquote: ({ className, ...props }) => (
            <blockquote
              className={cn(
                "my-3 border-l-2 border-border pl-3 text-muted-foreground",
                className,
              )}
              {...props}
            />
          ),
          code: ({ className, children, ...props }) => {
            const languageClass =
              typeof className === "string" && className.includes("language-")
            return (
              <code
                className={cn(
                  languageClass
                    ? "block bg-transparent p-0 font-mono text-xs leading-5"
                    : "whitespace-pre-wrap break-words rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] font-medium",
                  className,
                )}
                {...props}
              >
                {children}
              </code>
            )
          },
          del: ({ className, ...props }) => (
            <del className={cn("text-muted-foreground line-through", className)} {...props} />
          ),
          em: ({ className, ...props }) => (
            <em className={cn("italic", className)} {...props} />
          ),
          h1: ({ className, ...props }) => (
            <h1
              className={cn("mb-2 mt-4 text-xl font-semibold tracking-normal", className)}
              {...props}
            />
          ),
          h2: ({ className, ...props }) => (
            <h2
              className={cn("mb-2 mt-4 text-lg font-semibold tracking-normal", className)}
              {...props}
            />
          ),
          h3: ({ className, ...props }) => (
            <h3
              className={cn("mb-2 mt-3 text-base font-semibold tracking-normal", className)}
              {...props}
            />
          ),
          h4: ({ className, ...props }) => (
            <h4
              className={cn("mb-1.5 mt-3 text-sm font-semibold tracking-normal", className)}
              {...props}
            />
          ),
          h5: ({ className, ...props }) => (
            <h5
              className={cn("mb-1.5 mt-3 text-sm font-semibold tracking-normal", className)}
              {...props}
            />
          ),
          h6: ({ className, ...props }) => (
            <h6
              className={cn("mb-1 mt-3 text-xs font-semibold uppercase tracking-normal text-muted-foreground", className)}
              {...props}
            />
          ),
          hr: ({ className, ...props }) => (
            <hr className={cn("my-4 border-border", className)} {...props} />
          ),
          img: ({ className, ...props }) => (
            <img
              className={cn(
                "my-3 max-w-full rounded-md border border-border",
                className,
              )}
              loading="lazy"
              {...props}
            />
          ),
          input: ({ className, type, ...props }) =>
            type === "checkbox" ? (
              <input
                className={cn(
                  "mr-2 size-3.5 align-middle accent-primary disabled:opacity-70",
                  className,
                )}
                type={type}
                {...props}
              />
            ) : (
              <input className={className} type={type} {...props} />
            ),
          li: ({ className, ...props }) => (
            <li className={cn("pl-1 [&>p]:my-0", className)} {...props} />
          ),
          ol: ({ className, ...props }) => (
            <ol
              className={cn(
                "my-2 ml-5 list-decimal space-y-1 marker:text-muted-foreground",
                className,
              )}
              {...props}
            />
          ),
          p: ({ className, ...props }) => (
            <p className={cn("my-2 first:mt-0 last:mb-0", className)} {...props} />
          ),
          pre: ({ className, ...props }) => (
            <pre
              className={cn(
                "my-3 min-w-0 max-w-full overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-5 [&_code]:block [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:font-normal",
                className,
              )}
              {...props}
            />
          ),
          strong: ({ className, ...props }) => (
            <strong className={cn("font-semibold", className)} {...props} />
          ),
          table: ({ className, ...props }) => (
            <div className="my-3 max-w-full overflow-x-auto">
              <table
                className={cn(
                  "w-full border-collapse text-left text-sm [&_tbody_tr:nth-child(odd)]:bg-muted/30 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted/60 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold",
                  className,
                )}
                {...props}
              />
            </div>
          ),
          ul: ({ className, ...props }) => (
            <ul
              className={cn(
                "my-2 ml-5 list-disc space-y-1 marker:text-muted-foreground",
                className,
              )}
              {...props}
            />
          ),
        }}
      >
        {imageTagsToMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
}

type ImageTaggedTextPart =
  | { text: string; type: "text" }
  | { src: string; type: "image" }

type UserImagePreviewItem = {
  id: string
  name: string
  src: string
}

function textFromImageTaggedParts(parts: ImageTaggedTextPart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim()
}

function userImagePreviewItems(
  parts: ImageTaggedTextPart[],
  attachments: ChatMessageAttachment[],
): UserImagePreviewItem[] {
  const items: UserImagePreviewItem[] = []
  const seen = new Set<string>()
  const pushItem = (item: UserImagePreviewItem) => {
    if (seen.has(item.src)) {
      return
    }
    seen.add(item.src)
    items.push(item)
  }

  parts.forEach((part, index) => {
    if (part.type === "image") {
      pushItem({
        id: `inline-image:${index}:${part.src}`,
        name: "Attached image",
        src: part.src,
      })
    }
  })

  attachments.forEach((attachment) => {
    if (attachment.kind === "image") {
      pushItem({
        id: attachment.id,
        name: attachment.name,
        src: attachment.url,
      })
    }
  })

  return items
}

function imageTagsToMarkdown(text: string): string {
  return splitImageTags(text)
    .map((part) =>
      part.type === "image"
        ? `\n\n![](${encodeURI(part.src).replace(/\)/g, "%29")})\n\n`
        : part.text,
    )
    .join("")
}

function splitImageTags(text: string): ImageTaggedTextPart[] {
  const parts: ImageTaggedTextPart[] = []
  const pattern = /<image>\s*([\s\S]*?)\s*<\/image>/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), type: "text" })
    }

    const src = normalizeImageTagSource(match[1])
    parts.push(src ? { src, type: "image" } : { text: match[0], type: "text" })
    const trailingCloseTag = /^\s*<\/image>/i.exec(text.slice(pattern.lastIndex))
    if (src && trailingCloseTag) {
      pattern.lastIndex += trailingCloseTag[0].length
    }
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), type: "text" })
  }
  return parts.length ? parts : [{ text, type: "text" }]
}

function normalizeImageTagSource(value: string): string | null {
  let src = value.trim()
  while (/^<image>/i.test(src)) {
    src = src.replace(/^<image>\s*/i, "").trim()
  }
  while (/<\/image>$/i.test(src)) {
    src = src.replace(/\s*<\/image>$/i, "").trim()
  }
  if (
    !src ||
    /[\u0000-\u001f\u007f]/.test(src) ||
    src.includes("\n") ||
    src.includes("\r")
  ) {
    return null
  }
  if (
    src.startsWith("/") ||
    src.startsWith("data:image/") ||
    /^https?:\/\//i.test(src)
  ) {
    return src
  }
  return null
}

function parseLocalFileReference(href: string): FileViewerTarget | null {
  const trimmed = safeDecodeURIComponent(href.trim()).replace(/^<|>$/g, "")
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) &&
      !trimmed.startsWith("file://")
  ) {
    return null
  }
  const withoutFileScheme = trimmed.startsWith("file://")
    ? trimmed.slice("file://".length)
    : trimmed
  const hashLine = /^(.*)#L(\d+)(?:-L?\d+)?$/i.exec(withoutFileScheme)
  if (hashLine) {
    return { line: Number(hashLine[2]), path: hashLine[1] }
  }
  const colonLine = /^(.+):(\d+)(?::\d+)?$/.exec(withoutFileScheme)
  if (colonLine && !/^[A-Za-z]:\\/.test(withoutFileScheme)) {
    return { line: Number(colonLine[2]), path: colonLine[1] }
  }
  return { path: withoutFileScheme }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function FileViewerDialog({
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
      readChatWorkspaceFile(session, chatId, target!.path, target!.line ?? null),
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

function ProcessingDots() {
  return (
    <div
      aria-label="Codex is thinking"
      className="flex items-center gap-1 px-1 py-2"
    >
      {[0, 1, 2].map((index) => (
        <span
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
          key={index}
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </div>
  )
}

function ThinkingBlock({ message }: { message: ChatMessageResponse }) {
  return (
    <details
      className="group min-w-0 max-w-full overflow-hidden rounded-lg border border-dashed bg-muted/20 text-sm"
      open={message.status === "STREAMING"}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground">
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        <span>Reasoning</span>
      </summary>
      {message.content ? (
        <div className="min-w-0 whitespace-pre-wrap break-words border-t px-3 py-2 text-muted-foreground">
          {message.content}
        </div>
      ) : null}
    </details>
  )
}

function AssistantChatContent({
  latestProposedPlanMessageId,
  message,
  onImplementPlan,
  onRevisePlan,
  planActionDisabled,
  planActionPending,
}: {
  message: ChatMessageResponse
} & PlanActionHandlers) {
  const proposedPlan = proposedPlanFromMessage(message)
  const visibleText =
    proposedPlan?.source === "envelope"
      ? proposedPlan.surroundingText
      : message.content
  const showPlanActions =
    !!proposedPlan &&
    latestProposedPlanMessageId === message.id &&
    message.status === "COMPLETED"

  return (
    <div className="grid min-w-0 gap-2">
      {visibleText.trim() ? <AssistantMarkdown text={visibleText} /> : null}
      {proposedPlan ? (
        <ProposedPlanResultBlock
          disabled={planActionDisabled}
          message={message}
          pending={planActionPending}
          planBody={proposedPlan.body}
          showActions={showPlanActions}
          onImplementPlan={onImplementPlan}
          onRevisePlan={onRevisePlan}
        />
      ) : null}
    </div>
  )
}

function PlanBlock({
  latestProposedPlanMessageId,
  message,
  metadata,
  onImplementPlan,
  onRevisePlan,
  planActionDisabled,
  planActionPending,
}: {
  message: ChatMessageResponse
  metadata?: ChatPlanMetadata
} & PlanActionHandlers) {
  const steps = metadata?.steps ?? []
  const proposedPlan = proposedPlanFromMessage(message)
  const markdown = (proposedPlan?.body ?? message.content).trim()
  const showPlanActions =
    !!proposedPlan &&
    latestProposedPlanMessageId === message.id &&
    message.status === "COMPLETED"
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border bg-background p-3 text-sm">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <ListChecks className="size-4" />
        {showPlanActions ? "Proposed plan" : "Plan"}
      </div>
      {markdown ? (
        <AssistantMarkdown text={markdown} />
      ) : metadata?.explanation ? (
        <div className="mb-3 text-muted-foreground">{metadata.explanation}</div>
      ) : (
        <SystemText text="Planning..." />
      )}
      {steps.length ? (
        <div className="mt-3 grid min-w-0 gap-2">
          {steps.map((step, index) => (
            <div className="flex items-start gap-2" key={`${step.step}-${index}`}>
              <Badge variant={step.status === "completed" ? "default" : "secondary"}>
                {step.status}
              </Badge>
              <div className="min-w-0 flex-1">{step.step}</div>
            </div>
          ))}
        </div>
      ) : null}
      {showPlanActions && proposedPlan ? (
        <ProposedPlanActionCard
          disabled={planActionDisabled}
          message={message}
          pending={planActionPending}
          planBody={proposedPlan.body}
          onImplementPlan={onImplementPlan}
          onRevisePlan={onRevisePlan}
        />
      ) : null}
    </div>
  )
}

function ProposedPlanResultBlock({
  disabled,
  message,
  onImplementPlan,
  onRevisePlan,
  pending,
  planBody,
  showActions,
}: {
  disabled?: boolean
  message: ChatMessageResponse
  onImplementPlan?: (action: ProposedPlanAction) => void
  onRevisePlan?: (action: ProposedPlanRevisionAction) => void
  pending?: boolean
  planBody: string
  showActions?: boolean
}) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border bg-background p-3 text-sm">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <ListChecks className="size-4" />
        Proposed plan
      </div>
      <AssistantMarkdown text={planBody} />
      {showActions ? (
        <ProposedPlanActionCard
          disabled={disabled}
          message={message}
          pending={pending}
          planBody={planBody}
          onImplementPlan={onImplementPlan}
          onRevisePlan={onRevisePlan}
        />
      ) : null}
    </div>
  )
}

function ProposedPlanActionCard({
  disabled,
  message,
  onImplementPlan,
  onRevisePlan,
  pending,
  planBody,
}: {
  disabled?: boolean
  message: ChatMessageResponse
  onImplementPlan?: (action: ProposedPlanAction) => void
  onRevisePlan?: (action: ProposedPlanRevisionAction) => void
  pending?: boolean
  planBody: string
}) {
  const [feedback, setFeedback] = useState("")
  const [open, setOpen] = useState(false)
  const locked = disabled || pending
  const canRevise = !!onRevisePlan && feedback.trim().length > 0 && !locked

  return (
    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 border-t pt-3">
      <Button
        disabled={locked || !onImplementPlan}
        size="sm"
        type="button"
        onClick={() => onImplementPlan?.({ message, planBody })}
      >
        {pending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
        Implement plan
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button
              disabled={locked || !onRevisePlan}
              size="sm"
              type="button"
              variant="outline"
            />
          }
        >
          <PencilLine />
          Tell Codex what to change
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tell Codex What To Change</DialogTitle>
            <DialogDescription>
              Describe what should be adjusted. Codex will revise the plan before implementing.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Textarea
              className="min-h-32 resize-y"
              placeholder="Change the plan to..."
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={!canRevise}
                type="button"
                onClick={() => {
                  const trimmedFeedback = feedback.trim()
                  if (!trimmedFeedback) {
                    return
                  }
                  onRevisePlan?.({
                    feedback: trimmedFeedback,
                    message,
                    planBody,
                  })
                  setFeedback("")
                  setOpen(false)
                }}
              >
                {pending ? <Loader2 className="animate-spin" /> : <PencilLine />}
                Send changes
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type ProposedPlanCandidate = {
  body: string
  source: "envelope" | "planItem"
  surroundingText: string
}

const PROPOSED_PLAN_ENVELOPE =
  /<proposed_plan\b[^>]*>([\s\S]*?)<\/proposed_plan>/i

function latestProposedPlanMessageIdFrom(
  messages: ChatMessageResponse[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.status !== "COMPLETED") {
      continue
    }
    if (proposedPlanFromMessage(message)) {
      return message.id
    }
  }
  return null
}

function proposedPlanFromMessage(
  message: ChatMessageResponse,
): ProposedPlanCandidate | null {
  const rawText = message.content.trim()
  if (!rawText || rawText === "Planning...") {
    return null
  }

  const envelope = PROPOSED_PLAN_ENVELOPE.exec(message.content)
  if (envelope?.[1]?.trim()) {
    return {
      body: envelope[1].trim(),
      source: "envelope",
      surroundingText: message.content.replace(PROPOSED_PLAN_ENVELOPE, "").trim(),
    }
  }

  if (message.kind !== "PLAN") {
    return null
  }

  const metadata = metadataAs<ChatPlanMetadata>(message.metadata)
  if (metadata?.presentation !== "result") {
    return null
  }

  return {
    body: rawText,
    source: "planItem",
    surroundingText: "",
  }
}

function CommandBlock({ metadata }: { metadata?: ChatCommandMetadata }) {
  const status = metadata?.status ?? "running"
  const openByDefault = status !== "completed" && status !== "success"
  return (
    <details
      className="group min-w-0 max-w-full overflow-hidden rounded-lg border bg-background text-sm"
      open={openByDefault}
    >
      <summary className="grid min-w-0 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 shrink-0" />
          <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {metadata?.command ?? "command"}
          </code>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={commandBadgeVariant(metadata)}>
            {commandStatusLabel(metadata)}
          </Badge>
          {typeof metadata?.exitCode === "number" ? (
            <Badge variant={metadata.exitCode === 0 ? "secondary" : "destructive"}>
              {metadata.exitCode}
            </Badge>
          ) : null}
        </div>
      </summary>
      <div className="min-w-0 max-w-full overflow-hidden border-t px-3 py-2">
        {metadata?.cwd ? (
          <div className="mb-2 truncate text-xs text-muted-foreground">
            {metadata.cwd}
          </div>
        ) : null}
        <pre className="max-h-64 min-w-0 max-w-full overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">
          {metadata?.output || "(no output)"}
        </pre>
      </div>
    </details>
  )
}

function ToolBurstBlock({ messages }: { messages: ChatMessageResponse[] }) {
  const [expanded, setExpanded] = useState(false)
  const activeMessage = [...messages]
    .reverse()
    .find((message) => message.status === "STREAMING" || message.status === "PENDING")
  const visibleMessages = expanded
    ? messages
    : uniqueMessages([
        ...messages.slice(0, TOOL_BURST_VISIBLE_COUNT),
        ...(activeMessage ? [activeMessage] : []),
      ])
  const hiddenCount = Math.max(0, messages.length - visibleMessages.length)
  const status = mergeMessageStatus(messages)
  return (
    <details
      className="group min-w-0 max-w-full overflow-hidden rounded-lg border bg-background text-sm"
      open={status === "STREAMING" || status === "PENDING"}
    >
      <summary className="grid min-w-0 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 shrink-0" />
          <span className="truncate font-medium">
            {messages.length} {messages.length === 1 ? "action" : "actions"}
          </span>
        </div>
        <Badge variant="secondary">{status.toLowerCase()}</Badge>
      </summary>
      <div className="grid min-w-0 gap-1.5 border-t px-3 py-2">
        {visibleMessages.map((message) => (
          <CompactActionRow key={message.id} message={message} />
        ))}
        {hiddenCount > 0 ? (
          <Button
            className="mt-1 justify-start px-2 text-muted-foreground"
            size="sm"
            type="button"
            variant="ghost"
            onClick={(event) => {
              event.preventDefault()
              setExpanded(true)
            }}
          >
            +{hiddenCount} commands/actions
          </Button>
        ) : null}
      </div>
    </details>
  )
}

function PreviousActionsBlock({ messages }: { messages: ChatMessageResponse[] }) {
  return (
    <details className="group min-w-0 max-w-full overflow-hidden rounded-lg border bg-muted/20 text-sm">
      <summary className="grid min-w-0 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-muted-foreground">
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 shrink-0" />
          <span className="truncate">
            {messages.length} previous {messages.length === 1 ? "action" : "actions"}
          </span>
        </div>
        <Badge variant="secondary">collapsed</Badge>
      </summary>
      <div className="grid min-w-0 gap-1.5 border-t px-3 py-2">
        {messages.map((message) => (
          <CompactActionRow key={message.id} message={message} />
        ))}
      </div>
    </details>
  )
}

function CompactActionRow({ message }: { message: ChatMessageResponse }) {
  const metadata = metadataAs<ChatCommandMetadata | ChatApprovalMetadata | ChatUserInputMetadata>(
    message.metadata,
  )
  const commandMetadata = metadataAs<ChatCommandMetadata>(message.metadata)
  const label = compactActionLabel(message, metadata)
  const detail =
    message.kind === "COMMAND_EXECUTION"
      ? commandMetadata?.output || commandMetadata?.cwd
      : message.content.trim()
  return (
    <div className="grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 overflow-hidden rounded-md bg-muted/45 px-2 py-1.5">
      {compactActionIcon(message)}
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{label}</div>
        {detail ? (
          <div className="line-clamp-2 break-words text-xs leading-4 text-muted-foreground">
            {detail}
          </div>
        ) : null}
      </div>
      <Badge variant="secondary">{message.status.toLowerCase()}</Badge>
    </div>
  )
}

function FileChangeBlock({
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
      (message) => message.status === "STREAMING" || message.status === "PENDING",
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
                <DialogTrigger render={<Button size="icon-sm" variant="ghost" />}>
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
                  {entry.diff?.trim() || summary.diff?.trim() || "No diff body was reported for this file."}
                </pre>
              </DialogContent>
            </Dialog>
          ))
        ) : (
          <div className="px-3 py-2 text-muted-foreground">Changes detected.</div>
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

function summarizeFileChanges(messages: ChatMessageResponse[]): FileChangeSummary {
  const ordered = [...messages].sort((left, right) => left.sequence - right.sequence)
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
        path: existing.path.length <= entry.path.length ? existing.path : entry.path,
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
  if (lines.some((line) => line.startsWith("new file mode ") || line === "--- /dev/null")) {
    return "Created"
  }
  if (lines.some((line) => line.startsWith("deleted file mode ") || line === "+++ /dev/null")) {
    return "Deleted"
  }
  if (lines.some((line) => line.startsWith("rename from ") || line.startsWith("rename to "))) {
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
  return actions.size === 1 ? Array.from(actions)[0] ?? "Edited" : "Edited"
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
      <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
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

function mergeDiffText(...values: Array<string | undefined>): string | undefined {
  const parts = values
    .map((value) => value?.trim())
    .filter((value): value is string => !!value)
  if (!parts.length) {
    return undefined
  }
  return Array.from(new Set(parts)).join("\n\n")
}

function commandStatusLabel(metadata?: ChatCommandMetadata): string {
  if (metadata?.status) {
    return metadata.status
  }
  if (typeof metadata?.exitCode === "number") {
    return metadata.exitCode === 0 ? "completed" : "failed"
  }
  return "running"
}

function commandBadgeVariant(
  metadata?: ChatCommandMetadata,
): "secondary" | "destructive" {
  const status = metadata?.status?.toLowerCase() ?? ""
  if (
    status.includes("fail") ||
    status.includes("error") ||
    (typeof metadata?.exitCode === "number" && metadata.exitCode !== 0)
  ) {
    return "destructive"
  }
  return "secondary"
}

function ApprovalBlock({
  chatId,
  compact = false,
  message,
  metadata,
  session,
}: {
  chatId: string
  compact?: boolean
  message: ChatMessageResponse
  metadata?: ChatApprovalMetadata
  session: WebSession
}) {
  const resolved = metadata?.status === "resolved" || message.status === "COMPLETED"
  const respond = useServerRequestMutation(chatId, message, session)

  const send = (body: ServerRequestResponseRequest) => respond.mutate(body)

  if (resolved || metadata?.status === "expired") {
    return (
      <DecisionSummary
        icon={<LockKeyhole className="size-4" />}
        status={metadata?.status ?? (resolved ? "resolved" : undefined)}
        title={
          metadata?.requestKind === "permissions"
            ? "Permission request"
            : "Approval request"
        }
        value={summarizeApprovalDecision(metadata)}
      />
    )
  }

  return (
    <div
      className={cn(
        "min-w-0 max-w-full overflow-hidden rounded-md border bg-muted/35 text-sm text-foreground",
        compact ? "p-2" : "p-3",
      )}
    >
      <div className={cn("flex items-center gap-2 font-medium", compact ? "mb-1.5" : "mb-2")}>
        <LockKeyhole className="size-4" />
        {metadata?.requestKind === "permissions" ? "Permission request" : "Approval required"}
      </div>
      {metadata?.reason ? (
        <div className={cn("text-sm", compact ? "mb-1.5 line-clamp-2" : "mb-2")}>
          {metadata.reason}
        </div>
      ) : null}
      {metadata?.command ? (
        <code className="block min-w-0 max-w-full overflow-x-auto rounded border bg-background px-2 py-1 font-mono text-xs">
          {metadata.command}
        </code>
      ) : null}
      <div className={cn("flex flex-wrap gap-2", compact ? "mt-2" : "mt-3")}>
        {resolved ? (
          <Badge variant="secondary">
            <Check className="size-3" />
            resolved
          </Badge>
        ) : (
          <>
            <Button
              disabled={respond.isPending}
              size="sm"
              onClick={() =>
                send(
                  metadata?.requestKind === "permissions"
                    ? { kind: "permissions", result: { scope: "turn", permissions: true } }
                    : { decision: "accept", kind: "approval" },
                )
              }
            >
              {respond.isPending ? <Loader2 className="animate-spin" /> : <Check />}
              Accept
            </Button>
            <Button
              disabled={respond.isPending}
              size="sm"
              variant="outline"
              onClick={() =>
                send(
                  metadata?.requestKind === "permissions"
                    ? { kind: "permissions", result: { scope: "session", permissions: true } }
                    : { decision: "acceptForSession", kind: "approval" },
                )
              }
            >
              Accept for session
            </Button>
            <Button
              disabled={respond.isPending}
              size="sm"
              variant="outline"
              onClick={() =>
                send(
                  metadata?.requestKind === "permissions"
                    ? { kind: "permissions", result: { permissions: false } }
                    : { decision: "decline", kind: "approval" },
                )
              }
            >
              Decline
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function UserInputBlock({
  chatId,
  compact = false,
  message,
  metadata,
  session,
}: {
  chatId: string
  compact?: boolean
  message: ChatMessageResponse
  metadata?: ChatUserInputMetadata
  session: WebSession
}) {
  const [answers, setAnswers] = useState<UserInputAnswerState>({})
  const [questionIndex, setQuestionIndex] = useState(0)
  const respond = useServerRequestMutation(chatId, message, session)
  const questions = metadata?.questions?.length
    ? metadata.questions
    : [{ id: "answer", question: metadata?.message ?? "Answer" }]
  const resolved = metadata?.status === "resolved" || message.status === "COMPLETED"
  const activeQuestionIndex = Math.min(questionIndex, Math.max(questions.length - 1, 0))
  const currentQuestion = questions[activeQuestionIndex]
  const currentAnswered = currentQuestion
    ? readQuestionAnswerValues(
        currentQuestion,
        answers[currentQuestion.id],
      ).length > 0
    : false
  const allAnswered = questions.every(
    (question) => readQuestionAnswerValues(question, answers[question.id]).length > 0,
  )
  const isLastQuestion = activeQuestionIndex >= questions.length - 1
  const goToNextQuestion = () =>
    setQuestionIndex((current) =>
      Math.min(current + 1, questions.length - 1),
    )

  if (resolved || metadata?.status === "expired") {
    return (
      <DecisionSummary
        icon={<Check className="size-4" />}
        status={metadata?.status ?? (resolved ? "resolved" : undefined)}
        title="Input request"
        value={summarizeUserInputDecision(metadata)}
      />
    )
  }

  const submit = () => {
    if (!allAnswered) {
      toast.error("Answer every question before submitting.")
      return
    }
    respond.mutate({
      kind: "userInput",
      result: buildUserInputResult(questions, answers),
    })
  }

  return (
    <div
      className={cn(
        "min-w-0 max-w-full overflow-hidden rounded-md border bg-background text-sm",
        compact ? "p-2" : "p-3",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-3",
          compact ? "mb-2" : "mb-3",
        )}
      >
        <div className="min-w-0 font-medium">
          {compact ? "Input needed" : "Codex needs input"}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label="Previous question"
            disabled={resolved || respond.isPending || activeQuestionIndex === 0}
            size="icon-xs"
            variant="ghost"
            onClick={() => setQuestionIndex((current) => Math.max(current - 1, 0))}
          >
            <ArrowLeft />
          </Button>
          <Badge variant="secondary">
            {activeQuestionIndex + 1} / {questions.length}
          </Badge>
          <Button
            aria-label="Next question"
            disabled={
              resolved || respond.isPending || isLastQuestion || !currentAnswered
            }
            size="icon-xs"
            variant="ghost"
            onClick={goToNextQuestion}
          >
            <ArrowRight />
          </Button>
          {resolved ? <Badge variant="secondary">resolved</Badge> : null}
        </div>
      </div>
      {currentQuestion ? (
        <QuestionField
          compact={compact}
          disabled={resolved || respond.isPending}
          question={currentQuestion}
          value={answers[currentQuestion.id] ?? EMPTY_USER_INPUT_ANSWER}
          onChange={(value) =>
            setAnswers((current) => ({
              ...current,
              [currentQuestion.id]: value,
            }))
          }
          onAutoAdvance={isLastQuestion ? undefined : goToNextQuestion}
        />
      ) : null}
      {isLastQuestion ? (
        <div className={cn("flex justify-end", compact ? "mt-2" : "mt-4")}>
          <Button
            disabled={resolved || respond.isPending || !allAnswered}
            size="sm"
            onClick={submit}
          >
            {respond.isPending ? <Loader2 className="animate-spin" /> : <Check />}
            Submit
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function DecisionSummary({
  icon,
  status,
  title,
  value,
}: {
  icon: ReactNode
  status?: string
  title: string
  value?: string
}) {
  return (
    <div className="grid min-w-0 max-w-full gap-1 overflow-hidden rounded-md border bg-muted/25 px-2.5 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 font-medium">{title}</span>
        {status ? <Badge variant="secondary">{status}</Badge> : null}
      </div>
      {value ? (
        <div className="line-clamp-2 break-words text-xs leading-4 text-muted-foreground">
          {value}
        </div>
      ) : null}
    </div>
  )
}

function summarizeApprovalDecision(metadata?: ChatApprovalMetadata): string {
  if (!metadata) {
    return "No decision details."
  }
  const value = metadata.decision ?? metadata.result
  if (value === undefined) {
    return metadata.status === "expired"
      ? "The request expired before a decision was sent."
      : "Decision sent."
  }
  return `Decision: ${formatDecisionValue(value)}`
}

function summarizeUserInputDecision(metadata?: ChatUserInputMetadata): string {
  if (!metadata) {
    return "No answer details."
  }
  if (metadata.status === "expired") {
    return "The request expired before an answer was sent."
  }
  const answers = readResolvedUserInputAnswers(metadata)
  return answers.length ? answers.join("; ") : "Answer sent."
}

function readResolvedUserInputAnswers(metadata: ChatUserInputMetadata): string[] {
  const result = metadata.result
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return []
  }
  const answerRoot = (result as { answers?: unknown }).answers
  if (!answerRoot || typeof answerRoot !== "object" || Array.isArray(answerRoot)) {
    return []
  }
  return Object.entries(answerRoot)
    .map(([questionId, answerValue]) => {
      const question = metadata.questions?.find((entry) => entry.id === questionId)
      const answers = readAnswerArray(answerValue)
      if (!answers.length) {
        return null
      }
      return `${question?.header ?? question?.question ?? questionId}: ${answers.join(", ")}`
    })
    .filter((entry): entry is string => !!entry)
}

function readAnswerArray(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return []
  }
  const answers = (value as { answers?: unknown }).answers
  if (!Array.isArray(answers)) {
    return []
  }
  return answers
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function formatDecisionValue(value: JsonSerializable): string {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  if (value === null) {
    return "none"
  }
  return JSON.stringify(value)
}

type UserInputAnswer = {
  other: string
  values: string[]
}

type UserInputAnswerState = Record<string, UserInputAnswer>

const EMPTY_USER_INPUT_ANSWER: UserInputAnswer = { other: "", values: [] }

function QuestionField({
  compact = false,
  disabled,
  onChange,
  onAutoAdvance,
  question,
  value,
}: {
  compact?: boolean
  disabled?: boolean
  onChange: (value: UserInputAnswer) => void
  onAutoAdvance?: () => void
  question: ChatUserInputQuestion
  value: UserInputAnswer
}) {
  const options = question.options ?? []
  const limit = selectionLimit(question)
  const selected = value.values ?? []
  const freeform = value.other ?? ""
  const update = (patch: Partial<UserInputAnswer>) =>
    onChange({ other: freeform, values: selected, ...patch })
  const toggleOption = (label: string) => {
    if (disabled) {
      return
    }
    if (limit === 1) {
      const alreadySelected = selected.includes(label)
      update({ values: alreadySelected ? [] : [label] })
      if (!alreadySelected) {
        onAutoAdvance?.()
      }
      return
    }
    if (selected.includes(label)) {
      update({ values: selected.filter((entry) => entry !== label) })
      return
    }
    if (typeof limit === "number" && selected.length >= limit) {
      return
    }
    update({ values: [...selected, label] })
  }

  return (
    <div className="grid min-w-0 max-w-full gap-2 overflow-hidden">
      <div className="grid min-w-0 gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {question.header ?? question.question}
        </span>
        {question.header ? (
          <span className={cn("text-sm", compact ? "leading-4" : "leading-5")}>
            {question.question}
          </span>
        ) : null}
      </div>
      {options.length ? (
        <div className={cn("grid min-w-0", compact ? "gap-1" : "gap-2")}>
          {options.map((option) => {
            const checked = selected.includes(option.label)
            const limitReached =
              typeof limit === "number" && limit > 1 && selected.length >= limit
            return (
              <Button
                aria-pressed={checked}
                className={cn(
                  "h-auto w-full min-w-0 justify-start overflow-hidden whitespace-normal text-left",
                  compact ? "min-h-9 px-2.5 py-1.5" : "min-h-12 px-3 py-2",
                )}
                disabled={disabled || (!checked && limitReached)}
                key={option.label}
                size="default"
                type="button"
                variant={checked ? "default" : "outline"}
                onClick={() => toggleOption(option.label)}
              >
                <span className={cn("grid min-w-0 flex-1 overflow-hidden", compact ? "gap-0.5" : "gap-1")}>
                  <span>{option.label}</span>
                  {option.description ? (
                    <span
                      className={cn(
                        "text-xs font-normal leading-4 opacity-75",
                        compact && "line-clamp-2",
                      )}
                    >
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {checked ? <Check className="ml-2 shrink-0" /> : null}
              </Button>
            )
          })}
        </div>
      ) : question.isSecret ? (
        <Input
          disabled={disabled}
          type="password"
          value={freeform}
          onChange={(event) => update({ other: event.target.value })}
        />
      ) : (
        <Textarea
          className={compact ? "min-h-14" : "min-h-20"}
          disabled={disabled}
          value={freeform}
          onChange={(event) => update({ other: event.target.value })}
        />
      )}
      {question.isOther && options.length ? (
        <Textarea
          className={compact ? "min-h-12" : "min-h-16"}
          disabled={disabled}
          placeholder="Other answer"
          value={freeform}
          onChange={(event) => update({ other: event.target.value })}
        />
      ) : null}
      {typeof limit === "number" && limit > 1 ? (
        <span className="text-xs text-muted-foreground">
          Select up to {limit}.
        </span>
      ) : null}
    </div>
  )
}

function buildUserInputResult(
  questions: ChatUserInputQuestion[],
  answers: UserInputAnswerState,
): JsonSerializable {
  return {
    answers: Object.fromEntries(
      questions.map((question) => [
        question.id,
        { answers: readQuestionAnswerValues(question, answers[question.id]) },
      ]),
    ),
  }
}

function readQuestionAnswerValues(
  question: ChatUserInputQuestion,
  answer: UserInputAnswer | undefined,
): string[] {
  const values = answer?.values ?? []
  const other = answer?.other ?? ""
  return [...values, ...(question.isOther || !question.options?.length ? [other] : [])]
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function selectionLimit(question: ChatUserInputQuestion): number | undefined {
  if (!question.options?.length) {
    return undefined
  }
  if (question.selectionLimit && question.selectionLimit > 0) {
    return question.selectionLimit
  }
  return 1
}

function ErrorBlock({
  metadata,
  text,
}: {
  metadata?: ChatErrorMetadata
  text: string
}) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4" />
        Error
      </div>
      <div className="min-w-0 whitespace-pre-wrap break-words">
        {metadata?.message ?? text}
      </div>
    </div>
  )
}

function SystemText({ text }: { text: string }) {
  return <div className="min-w-0 whitespace-pre-wrap break-words text-sm text-muted-foreground">{text}</div>
}

function useServerRequestMutation(
  chatId: string,
  message: ChatMessageResponse,
  session: WebSession,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: ServerRequestResponseRequest) => {
      if (!message.requestId) {
        throw new Error("Request id is missing.")
      }
      return respondToServerRequest(session, chatId, message.requestId, body)
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (updated) => {
      queryClient.setQueryData<MessagePageResponse | undefined>(
        ["messages", chatId],
        (page) => appendMessage(page, updated),
      )
    },
  })
}

const TOOL_BURST_VISIBLE_COUNT = 5

function projectCodexRenderItems(
  messages: ChatMessageResponse[],
): CodexRenderItem[] {
  const compacted = compactAssistantChatMessages(
    [...messages].sort((a, b) => a.sequence - b.sequence),
  )
  const collapsed = collapseCompletedTurnActions(compacted)
  const fileCompacted = compactFileChangeBlocks(collapsed)
  return compactToolBursts(fileCompacted)
}

type CodexRenderSourceItem =
  | { message: ChatMessageResponse; sequence: number; type: "message" }
  | { messages: ChatMessageResponse[]; sequence: number; type: "previousActions" }
  | { messages: ChatMessageResponse[]; sequence: number; type: "fileChanges" }

function collapseCompletedTurnActions(
  messages: ChatMessageResponse[],
): CodexRenderSourceItem[] {
  const active = messages.some(
    (message) => message.status === "STREAMING" || message.status === "PENDING",
  )
  if (active) {
    return messages.map((message) => ({
      message,
      sequence: message.sequence,
      type: "message" as const,
    }))
  }

  const finalAssistant = findFinalAssistantMessage(messages)
  const previousActions: ChatMessageResponse[] = []
  const visibleMessages: ChatMessageResponse[] = []

  for (const message of messages) {
    if (isPreviousActionCandidate(message, finalAssistant)) {
      previousActions.push(message)
    } else {
      visibleMessages.push(message)
    }
  }

  const sourceItems: CodexRenderSourceItem[] = visibleMessages.map((message) => ({
    message,
    sequence: message.sequence,
    type: "message" as const,
  }))
  if (!previousActions.length) {
    return sourceItems
  }

  const previousSequence = Math.min(
    ...previousActions.map((message) => message.sequence),
  )
  const insertIndex = sourceItems.findIndex(
    (item) => item.sequence > previousSequence,
  )
  const previousItem: CodexRenderSourceItem = {
    messages: previousActions,
    sequence: previousSequence,
    type: "previousActions",
  }
  if (insertIndex < 0) {
    return [...sourceItems, previousItem]
  }
  return [
    ...sourceItems.slice(0, insertIndex),
    previousItem,
    ...sourceItems.slice(insertIndex),
  ]
}

function compactToolBursts(items: CodexRenderSourceItem[]): CodexRenderItem[] {
  const projected: CodexRenderItem[] = []
  let pending: ChatMessageResponse[] = []

  const flushPending = () => {
    if (!pending.length) {
      return
    }
    if (pending.length === 1) {
      const [message] = pending
      projected.push({
        id: `message:${message.id}`,
        message,
        type: "message",
      })
    } else {
      projected.push({
        id: `tool-burst:${pending.map((message) => message.id).join(":")}`,
        messages: pending,
        type: "toolBurst",
      })
    }
    pending = []
  }

  for (const item of items) {
    if (item.type === "previousActions" || item.type === "fileChanges") {
      flushPending()
      projected.push({
        id: `${item.type}:${item.messages.map((message) => message.id).join(":")}`,
        messages: item.messages,
        type: item.type,
      })
      continue
    }

    if (isToolBurstCandidate(item.message)) {
      const previous = pending.at(-1)
      if (!previous || sameActionBurst(previous, item.message)) {
        pending.push(item.message)
        continue
      }
      flushPending()
      pending.push(item.message)
      continue
    }

    flushPending()
    projected.push({
      id: `message:${item.message.id}`,
      message: item.message,
      type: "message",
    })
  }

  flushPending()
  return projected
}

function compactFileChangeBlocks(
  items: CodexRenderSourceItem[],
): CodexRenderSourceItem[] {
  const projected: CodexRenderSourceItem[] = []
  let pending: ChatMessageResponse[] = []

  const flushPending = () => {
    if (!pending.length) {
      return
    }
    const sequence = Math.min(...pending.map((message) => message.sequence))
    projected.push({
      messages: pending,
      sequence,
      type: "fileChanges",
    })
    pending = []
  }

  for (const item of items) {
    if (item.type !== "message" || item.message.kind !== "FILE_CHANGE") {
      flushPending()
      projected.push(item)
      continue
    }

    const previous = pending.at(-1)
    if (previous && actionBurstKey(previous) !== actionBurstKey(item.message)) {
      flushPending()
    }
    pending.push(item.message)
  }

  flushPending()
  return projected
}

export function projectTimelineMessages(messages: ChatMessageResponse[]) {
  const ordered = collapseDuplicateTimelineMessages([...messages])
    .filter((message) => !isHiddenTimelineMessage(message))
    .sort((a, b) => a.sequence - b.sequence)
  const groups = new Map<string, ChatMessageResponse[]>()

  for (const message of ordered) {
    const turnKey = message.turnId ? `turn:${message.turnId}` : `message:${message.id}`
    const group = groups.get(turnKey)
    if (group) {
      group.push(message)
    } else {
      groups.set(turnKey, [message])
    }
  }

  return Array.from(groups.values()).flatMap((group) => {
    const active = group.some((message) => message.status === "STREAMING" || message.status === "PENDING")
    if (active) {
      return group
    }
    return [
      ...group.filter((message) => message.kind !== "FILE_CHANGE"),
      ...group.filter((message) => message.kind === "FILE_CHANGE"),
    ]
  })
}

function collapseDuplicateTimelineMessages(
  messages: ChatMessageResponse[],
): ChatMessageResponse[] {
  const ordered = [...messages].sort((a, b) => a.sequence - b.sequence)
  const collapsed: ChatMessageResponse[] = []
  const indexByKey = new Map<string, number>()

  for (const message of ordered) {
    const key = duplicateTimelineKey(message)
    if (!key) {
      collapsed.push(message)
      continue
    }

    const existingIndex = indexByKey.get(key)
    if (existingIndex === undefined) {
      indexByKey.set(key, collapsed.length)
      collapsed.push(message)
      continue
    }

    collapsed[existingIndex] = chooseTimelineDuplicate(
      collapsed[existingIndex],
      message,
    )
  }

  return collapsed
}

function duplicateTimelineKey(message: ChatMessageResponse): string | null {
  if (message.requestId) {
    return `${message.runId ?? message.chatId}:${message.kind}:request:${message.requestId}`
  }
  if (message.itemId) {
    return `${message.runId ?? message.chatId}:${message.kind}:item:${message.itemId}`
  }
  return null
}

function chooseTimelineDuplicate(
  existing: ChatMessageResponse,
  next: ChatMessageResponse,
): ChatMessageResponse {
  if (existing.kind === "PLAN") {
    if (next.content.length > existing.content.length) {
      return next
    }
    if (messageStatusPriority(next.status) > messageStatusPriority(existing.status)) {
      return { ...existing, status: next.status }
    }
    return existing
  }

  if (messageStatusPriority(next.status) > messageStatusPriority(existing.status)) {
    return next
  }
  return next.sequence >= existing.sequence ? next : existing
}

function messageStatusPriority(status: ChatMessageResponse["status"]): number {
  switch (status) {
    case "FAILED":
      return 4
    case "COMPLETED":
      return 3
    case "STREAMING":
      return 2
    case "PENDING":
    default:
      return 1
  }
}

function groupTimelineEntries(messages: ChatMessageResponse[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []

  for (const message of messages) {
    if (message.role === "USER") {
      entries.push({ id: `user:${message.id}`, message, type: "user" })
      continue
    }

    const groupId = codexTurnGroupId(message)
    const previous = entries.at(-1)
    if (previous?.type === "codex" && previous.id === groupId) {
      previous.messages.push(message)
      continue
    }
    if (
      previous?.type === "codex" &&
      shouldMergeAdjacentCodexResponse(previous.messages.at(-1), message)
    ) {
      previous.messages.push(message)
      continue
    }

    entries.push({ id: groupId, messages: [message], type: "codex" })
  }

  return entries
}

function shouldMergeAdjacentCodexResponse(
  previous: ChatMessageResponse | undefined,
  next: ChatMessageResponse,
): boolean {
  return (
    previous?.role === "ASSISTANT" &&
    previous.kind === "CHAT" &&
    next.role === "ASSISTANT" &&
    next.kind === "CHAT"
  )
}

function codexTurnGroupId(message: ChatMessageResponse): string {
  if (message.runId) {
    return `codex-run:${message.runId}`
  }
  if (message.turnId) {
    return `codex-turn:${message.turnId}`
  }
  return `codex-message:${message.id}`
}

function compactAssistantChatMessages(
  messages: ChatMessageResponse[],
): ChatMessageResponse[] {
  const compacted: ChatMessageResponse[] = []
  let pendingAssistantChat: ChatMessageResponse[] = []

  const flushAssistantChat = () => {
    if (!pendingAssistantChat.length) {
      return
    }
    compacted.push(mergeAssistantChatMessages(pendingAssistantChat))
    pendingAssistantChat = []
  }

  for (const message of messages) {
    if (message.role === "ASSISTANT" && message.kind === "CHAT") {
      pendingAssistantChat.push(message)
      continue
    }
    flushAssistantChat()
    compacted.push(message)
  }

  flushAssistantChat()
  return compacted
}

function mergeAssistantChatMessages(
  messages: ChatMessageResponse[],
): ChatMessageResponse {
  if (messages.length === 1) {
    return messages[0]
  }

  const last = messages[messages.length - 1]
  return {
    ...last,
    content: mergeAssistantContents(messages.map((message) => message.content)),
    id: messages.map((message) => message.id).join(":"),
    status: mergeMessageStatus(messages),
  }
}

function mergeAssistantContents(contents: string[]): string {
  const merged: string[] = []

  for (const content of contents) {
    if (!content.trim()) {
      continue
    }
    const duplicateIndex = merged.findIndex(
      (existing) => existing === content || existing.startsWith(content),
    )
    if (duplicateIndex >= 0) {
      continue
    }

    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (content.startsWith(merged[index])) {
        merged.splice(index, 1)
      }
    }
    merged.push(content)
  }

  return merged.join("\n\n")
}

function mergeMessageStatus(
  messages: ChatMessageResponse[],
): ChatMessageResponse["status"] {
  if (messages.some((message) => message.status === "FAILED")) {
    return "FAILED"
  }
  if (messages.some((message) => message.status === "STREAMING")) {
    return "STREAMING"
  }
  if (messages.some((message) => message.status === "PENDING")) {
    return "PENDING"
  }
  return "COMPLETED"
}

export function findStickyChatContext(messages: ChatMessageResponse[]) {
  const ordered = collapseDuplicateTimelineMessages(messages).sort(
    (a, b) => b.sequence - a.sequence,
  )
  return {
    pendingRequest: ordered.find(isPendingDecisionMessage),
  }
}

function isPendingDecisionMessage(message: ChatMessageResponse): boolean {
  if (message.kind !== "APPROVAL" && message.kind !== "USER_INPUT_PROMPT") {
    return false
  }
  if (message.status === "COMPLETED" || message.status === "FAILED") {
    return false
  }
  const metadata = metadataAs<ChatApprovalMetadata | ChatUserInputMetadata>(
    message.metadata,
  )
  return metadata?.status !== "resolved" && metadata?.status !== "expired"
}

function isHiddenTimelineMessage(message: ChatMessageResponse): boolean {
  if (isEmptyPlanMessage(message)) {
    return true
  }
  if (isPlaceholderThinkingMessage(message)) {
    return true
  }
  if (message.kind === "CHAT" && message.role === "ASSISTANT") {
    return (
      message.content.trim().length === 0 &&
      message.status !== "PENDING" &&
      message.status !== "STREAMING"
    )
  }
  return false
}

function isPlaceholderThinkingMessage(message: ChatMessageResponse): boolean {
  return (
    message.kind === "THINKING" &&
    message.content.trim().toLowerCase() === "thinking..."
  )
}

function isEmptyPlanMessage(message: ChatMessageResponse): boolean {
  if (message.kind !== "PLAN") {
    return false
  }
  const metadata = metadataAs<ChatPlanMetadata>(message.metadata)
  return (
    message.content.trim().length === 0 &&
    !metadata?.explanation?.trim() &&
    !(metadata?.steps?.length)
  )
}

function findFinalAssistantMessage(
  messages: ChatMessageResponse[],
): ChatMessageResponse | undefined {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "ASSISTANT" &&
        message.kind === "CHAT" &&
        message.content.trim().length > 0,
    )
}

function isPreviousActionCandidate(
  message: ChatMessageResponse,
  finalAssistant?: ChatMessageResponse,
): boolean {
  if (message.id === finalAssistant?.id) {
    return false
  }
  if (message.kind === "ERROR" || message.kind === "FILE_CHANGE" || message.kind === "PLAN") {
    return false
  }
  if (isPendingDecisionMessage(message)) {
    return false
  }
  if (message.kind === "APPROVAL" || message.kind === "USER_INPUT_PROMPT") {
    return true
  }
  if (message.kind === "THINKING" || message.kind === "TOOL_ACTIVITY") {
    return true
  }
  if (message.kind === "COMMAND_EXECUTION") {
    return message.status !== "FAILED"
  }
  if (message.role === "ASSISTANT" && message.kind === "CHAT") {
    return !!finalAssistant && finalAssistant.content.includes(message.content.trim())
  }
  return false
}

function isToolBurstCandidate(message: ChatMessageResponse): boolean {
  return message.kind === "COMMAND_EXECUTION" || message.kind === "TOOL_ACTIVITY"
}

function sameActionBurst(
  left: ChatMessageResponse,
  right: ChatMessageResponse,
): boolean {
  return actionBurstKey(left) === actionBurstKey(right)
}

function actionBurstKey(message: ChatMessageResponse): string {
  return message.runId ?? message.turnId ?? message.chatId
}

function uniqueMessages(messages: ChatMessageResponse[]): ChatMessageResponse[] {
  const seen = new Set<string>()
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false
    }
    seen.add(message.id)
    return true
  })
}

function compactActionLabel(
  message: ChatMessageResponse,
  metadata?: ChatMessageMetadata,
): string {
  if (message.kind === "COMMAND_EXECUTION") {
    const command = metadataAs<ChatCommandMetadata>(metadata)
    return (command?.command ?? message.content.trim()) || "Command"
  }
  if (message.kind === "TOOL_ACTIVITY") {
    return message.content.trim() || "Tool activity"
  }
  if (message.kind === "THINKING") {
    return "Reasoning"
  }
  if (message.kind === "APPROVAL") {
    const approval = metadataAs<ChatApprovalMetadata>(metadata)
    return approval?.requestKind === "permissions"
      ? "Permission request"
      : "Approval request"
  }
  if (message.kind === "USER_INPUT_PROMPT") {
    return "Input request"
  }
  if (message.kind === "CHAT") {
    return "Assistant draft"
  }
  return message.kind.toLowerCase().replaceAll("_", " ")
}

function compactActionIcon(message: ChatMessageResponse): ReactNode {
  if (message.kind === "COMMAND_EXECUTION") {
    return <Terminal className="mt-0.5 size-3.5 text-muted-foreground" />
  }
  if (message.kind === "APPROVAL" || message.kind === "USER_INPUT_PROMPT") {
    return <LockKeyhole className="mt-0.5 size-3.5 text-muted-foreground" />
  }
  if (message.kind === "THINKING") {
    return <BrainIcon />
  }
  return <Code2 className="mt-0.5 size-3.5 text-muted-foreground" />
}

function BrainIcon() {
  return <ListChecks className="mt-0.5 size-3.5 text-muted-foreground" />
}

function metadataAs<TMetadata extends ChatMessageMetadata>(
  metadata: ChatMessageResponse["metadata"],
): TMetadata | undefined {
  return metadata && typeof metadata === "object"
    ? (metadata as TMetadata)
    : undefined
}

function messageAttachments(message: ChatMessageResponse): ChatMessageAttachment[] {
  const metadata = message.metadata as { attachments?: unknown } | null
  return Array.isArray(metadata?.attachments)
    ? metadata.attachments.filter(
        (attachment): attachment is ChatMessageAttachment => {
          if (!attachment || typeof attachment !== "object") {
            return false
          }
          const kind = (attachment as { kind?: unknown }).kind
          return kind === "image" || kind === "file"
        },
      )
    : []
}

function readError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Request failed."
}
