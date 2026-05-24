import type {
  ChatApprovalMetadata,
  ChatCommandMetadata,
  ChatErrorMetadata,
  ChatGenericMetadata,
  ChatMessageResponse,
  ChatPlanMetadata,
  ChatUserInputMetadata,
  ChatUserInputQuestion,
  JsonSerializable,
  MessagePageResponse,
  ServerRequestResponseRequest,
} from "@/types"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock,
  FileCode,
  ListChecks,
  Loader2,
  LockKeyhole,
  PencilLine,
  Terminal,
  UserRound,
} from "lucide-react"
import type { ReactNode } from "react"
import { useMemo, useState } from "react"
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
import { Textarea } from "@/components/ui/textarea"
import { appendMessage, respondToServerRequest } from "@/lib/api"
import type { WebSession } from "@/lib/session-storage"
import { cn } from "@/lib/utils"
import { FileChangeBlock } from "@/components/timeline/file-change-block"
import {
  compactActionIcon,
  compactActionLabel,
  collapseDuplicateTimelineMessages,
  findStickyChatContext,
  groupTimelineEntries,
  isActiveMessage,
  isEmptyPlanMessage,
  isHiddenTimelineMessage,
  messageAttachments,
  metadataAs,
  mergeMessageStatus,
  projectCodexRenderItems,
  projectTimelineMessages,
  uniqueMessages,
  type CodexRenderItem,
  type TimelineEntry,
} from "@/components/timeline/timeline-projection"
import { FileViewerDialog } from "@/components/timeline/file-viewer"
import {
  FileViewerContext,
  type FileViewerTarget,
} from "@/components/timeline/file-viewer-context"
export {
  findStickyChatContext,
  projectTimelineMessages,
} from "@/components/timeline/timeline-projection"
import {
  AssistantMarkdown,
  splitImageTags,
  textFromImageTaggedParts,
  userImagePreviewItems,
  type UserImagePreviewItem,
} from "@/components/timeline/markdown-renderer"

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
  onSteerQueuedMessage,
  planActionDisabled,
  planActionPending,
  queuedMessageActionDisabled,
  queuedMessageActionPendingId,
  showProcessingTail,
  session,
}: {
  chatId: string
  fileChangeActionDisabled?: boolean
  fileChangeActionPending?: boolean
  hiddenMessageIds?: string[]
  messages: ChatMessageResponse[]
  onSteerQueuedMessage?: (action: QueuedMessageAction) => void
  onReviewFileChanges?: (action: FileChangePromptAction) => void
  onUndoFileChanges?: (action: FileChangePromptAction) => void
  onImplementPlan?: (action: ProposedPlanAction) => void
  onRevisePlan?: (action: ProposedPlanRevisionAction) => void
  planActionDisabled?: boolean
  planActionPending?: boolean
  queuedMessageActionDisabled?: boolean
  queuedMessageActionPendingId?: string | null
  showProcessingTail?: boolean
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
          onSteerQueuedMessage={onSteerQueuedMessage}
          onUndoFileChanges={onUndoFileChanges}
          planActionDisabled={planActionDisabled}
          planActionPending={planActionPending}
          queuedMessageActionDisabled={queuedMessageActionDisabled}
          queuedMessageActionPendingId={queuedMessageActionPendingId}
          session={session}
        />
      ))}
      {showProcessingTail ? <ProcessingTail /> : null}
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

export function PinnedPlanTasksPanel({
  message,
}: {
  message?: ChatMessageResponse | null
}) {
  if (!message) {
    return null
  }

  const metadata = metadataAs<ChatPlanMetadata>(message.metadata)
  const steps = metadata?.steps ?? []
  const completedStepCount = steps.filter((step) =>
    planStepIsComplete(step.status),
  ).length
  const highlightedStepIndex = highlightedPlanStepIndex(steps)
  const highlightedStep =
    highlightedStepIndex >= 0 ? steps[highlightedStepIndex] : undefined
  const summary =
    highlightedStep?.step ??
    normalizedPlanText(metadata?.explanation) ??
    normalizedPlanText(message.content) ??
    "Planning..."
  const statusLabel = pinnedPlanStatusLabel(message, steps)

  return (
    <section
      aria-label="Active plan"
      aria-live="polite"
      className="border-b bg-background px-3 py-2"
    >
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        <div className="min-w-0 overflow-hidden rounded-lg border bg-muted/20 shadow-sm">
          <div className="grid min-w-0 gap-2 p-3">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2">
                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
                  <ListChecks className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">Plan</span>
                    <Badge variant="secondary">{statusLabel}</Badge>
                  </div>
                  <div className="mt-0.5 min-w-0 truncate text-xs text-muted-foreground">
                    {summary}
                  </div>
                </div>
              </div>
              {steps.length ? (
                <Badge className="shrink-0" variant="outline">
                  {completedStepCount}/{steps.length}
                </Badge>
              ) : null}
            </div>

            {steps.length ? (
              <div className="grid max-h-44 min-w-0 gap-1.5 overflow-y-auto pr-1">
                {steps.map((step, index) => {
                  const highlighted = index === highlightedStepIndex
                  return (
                    <div
                      className={cn(
                        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-1.5 text-xs",
                        highlighted
                          ? "border bg-background shadow-xs"
                          : "text-muted-foreground",
                      )}
                      key={`${step.step}-${index}`}
                    >
                      <PlanStepMarker
                        highlighted={highlighted}
                        status={step.status}
                      />
                      <div className="min-w-0 break-words leading-5 text-foreground">
                        {step.step}
                      </div>
                      <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {planStepStatusLabel(step.status)}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

export function QueuedMessagesPanel({
  disabled,
  messages,
  onSteerQueuedMessage,
  pendingQueueId,
}: {
  disabled?: boolean
  messages: ChatMessageResponse[]
  onSteerQueuedMessage?: (action: QueuedMessageAction) => void
  pendingQueueId?: string | null
}) {
  if (!messages.length) {
    return null
  }

  return (
    <section className="border-b bg-background px-3 py-2">
      <div className="mx-auto grid w-full min-w-0 max-w-3xl gap-1.5">
        <div className="min-w-0 overflow-hidden rounded-lg border bg-muted/20 shadow-sm">
          <div className="flex min-w-0 items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <Clock className="size-4 shrink-0 text-muted-foreground" />
              <span>Queued messages</span>
            </div>
            <Badge variant="outline">{messages.length}</Badge>
          </div>
          <div className="grid max-h-44 min-w-0 gap-1 overflow-y-auto p-2">
            {messages.map((message) => {
              const delivery = userDeliveryState(message)
              const queueId = delivery?.queueId
              const pending = pendingQueueId === queueId
              return (
                <div
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-background px-2 py-1.5 text-xs"
                  key={message.id}
                >
                  <Clock className="size-3.5 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-foreground">
                      {queuedMessagePreview(message)}
                    </div>
                    <div className="text-muted-foreground">
                      Queued after the current task
                    </div>
                  </div>
                  <Button
                    className="h-7 shrink-0 px-2 text-xs"
                    disabled={
                      disabled || pending || !queueId || !onSteerQueuedMessage
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (queueId) {
                        onSteerQueuedMessage?.({ message, queueId })
                      }
                    }}
                  >
                    {pending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <ArrowRight />
                    )}
                    Steer
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

export function findPendingQueuedMessages(
  messages: ChatMessageResponse[],
): ChatMessageResponse[] {
  return projectTimelineMessages(messages).filter(isPendingQueuedMessage)
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

export type QueuedMessageAction = {
  message: ChatMessageResponse
  queueId: string
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

type QueuedMessageActionHandlers = {
  onSteerQueuedMessage?: (action: QueuedMessageAction) => void
  queuedMessageActionDisabled?: boolean
  queuedMessageActionPendingId?: string | null
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
  onSteerQueuedMessage,
  onUndoFileChanges,
  planActionDisabled,
  planActionPending,
  queuedMessageActionDisabled,
  queuedMessageActionPendingId,
  session,
}: {
  chatId: string
  entry: TimelineEntry
  session: WebSession
} & PlanActionHandlers &
  FileChangeActionHandlers &
  QueuedMessageActionHandlers) {
  if (entry.type === "user") {
    return (
      <UserMessageRow
        message={entry.message}
        queuedMessageActionDisabled={queuedMessageActionDisabled}
        queuedMessageActionPendingId={queuedMessageActionPendingId}
        onSteerQueuedMessage={onSteerQueuedMessage}
      />
    )
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
  const displayItems = useMemo(
    () => projectCodexRenderItems(messages),
    [messages],
  )
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

function UserMessageRow({
  message,
  onSteerQueuedMessage,
  queuedMessageActionDisabled,
  queuedMessageActionPendingId,
}: {
  message: ChatMessageResponse
} & QueuedMessageActionHandlers) {
  const attachments = messageAttachments(message)
  const delivery = userDeliveryState(message)
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
            <div className="mb-1 flex min-w-0 items-center justify-between gap-2 text-muted-foreground">
              <div className="flex min-w-0 items-center gap-2">
                <UserRound className="size-3.5 opacity-80" />
                <span className="text-xs font-medium">You</span>
              </div>
              {delivery ? (
                <Badge className="shrink-0" variant={delivery.badgeVariant}>
                  {delivery.label}
                </Badge>
              ) : null}
            </div>
            {textContent ? (
              <div className="whitespace-pre-wrap break-words">
                {textContent}
              </div>
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
            {delivery ? (
              <UserDeliveryFooter
                delivery={delivery}
                disabled={queuedMessageActionDisabled}
                pending={queuedMessageActionPendingId === delivery.queueId}
                onSteerQueuedMessage={
                  delivery.queueId
                    ? () =>
                        onSteerQueuedMessage?.({
                          message,
                          queueId: delivery.queueId!,
                        })
                    : undefined
                }
              />
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

function ProcessingTail() {
  return (
    <article className="mx-auto flex w-full min-w-0 max-w-full justify-start overflow-hidden">
      <div className="flex min-w-0 items-center gap-2 rounded-md px-1 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>Codex is processing</span>
      </div>
    </article>
  )
}

type UserDeliveryState = {
  badgeVariant: "default" | "secondary" | "destructive" | "outline"
  canSteer: boolean
  detail: string
  label: string
  queueId?: string
}

function UserDeliveryFooter({
  delivery,
  disabled,
  onSteerQueuedMessage,
  pending,
}: {
  delivery: UserDeliveryState
  disabled?: boolean
  onSteerQueuedMessage?: () => void
  pending?: boolean
}) {
  const canSteer =
    delivery.canSteer && !!onSteerQueuedMessage && !disabled && !pending
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
      <span className="min-w-0 break-words leading-5">{delivery.detail}</span>
      {delivery.canSteer ? (
        <Button
          className="h-7 shrink-0 px-2 text-xs"
          disabled={!canSteer}
          size="sm"
          type="button"
          variant="outline"
          onClick={onSteerQueuedMessage}
        >
          {pending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          Steer
        </Button>
      ) : null}
    </div>
  )
}

function userDeliveryState(
  message: ChatMessageResponse,
): UserDeliveryState | null {
  const metadata = metadataAs<ChatGenericMetadata>(message.metadata)
  const delivery = readMetadataString(metadata?.delivery)
  const queueStatus = readMetadataString(metadata?.queueStatus)
  const queueId = readMetadataString(metadata?.queueId)
  const error = readMetadataString(metadata?.error)

  if (delivery === "queue" || queueId) {
    const status = queueStatus ?? "queued"
    if (status === "failed") {
      return {
        badgeVariant: "destructive",
        canSteer: false,
        detail: error ? `Queue failed: ${error}` : "Queued message failed.",
        label: "failed",
        queueId,
      }
    }
    if (status === "running") {
      return {
        badgeVariant: "secondary",
        canSteer: false,
        detail: "Queued message is now running.",
        label: "running",
        queueId,
      }
    }
    if (status === "steered" || delivery === "steer") {
      return {
        badgeVariant: "secondary",
        canSteer: false,
        detail: "Steered into the active task.",
        label: "steered",
        queueId,
      }
    }
    return {
      badgeVariant: "outline",
      canSteer: !!queueId,
      detail: "Queued after the current task.",
      label: "queued",
      queueId,
    }
  }

  if (delivery === "steer") {
    return {
      badgeVariant: "secondary",
      canSteer: false,
      detail: "Steered into the active task.",
      label: "steered",
    }
  }

  return null
}

function isPendingQueuedMessage(message: ChatMessageResponse): boolean {
  return (
    message.role === "USER" && userDeliveryState(message)?.canSteer === true
  )
}

function queuedMessagePreview(message: ChatMessageResponse): string {
  const text = textFromImageTaggedParts(splitImageTags(message.content)).trim()
  if (text) {
    return text.length > 160 ? `${text.slice(0, 160)}...` : text
  }
  const attachments = messageAttachments(message)
  if (attachments.length) {
    return `${attachments.length} ${attachments.length === 1 ? "attachment" : "attachments"}`
  }
  return "Queued message"
}

function readMetadataString(
  value: JsonSerializable | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined
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
      return (
        <CommandBlock
          metadata={metadataAs<ChatCommandMetadata>(message.metadata)}
        />
      )
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
      return (
        <ErrorBlock
          metadata={metadataAs<ChatErrorMetadata>(message.metadata)}
          text={message.content}
        />
      )
    case "TOOL_ACTIVITY":
    default:
      return <SystemText text={message.content} />
  }
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
            <div
              className="flex items-start gap-2"
              key={`${step.step}-${index}`}
            >
              <Badge
                variant={step.status === "completed" ? "default" : "secondary"}
              >
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

type PlanStep = NonNullable<ChatPlanMetadata["steps"]>[number]

export function findPinnedProgressPlanMessage(
  messages: ChatMessageResponse[],
  isRunning: boolean,
): ChatMessageResponse | null {
  if (!isRunning) {
    return null
  }

  const ordered = collapseDuplicateTimelineMessages(messages)
    .filter((message) => !isHiddenTimelineMessage(message))
    .sort((a, b) => a.sequence - b.sequence)

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index]
    if (shouldDisplayPinnedProgressPlanMessage(message)) {
      return message
    }
  }

  return null
}

export function pinnedPlanMessageSignature(
  message?: ChatMessageResponse | null,
): string {
  if (!message) {
    return ""
  }
  const metadata = metadataAs<ChatPlanMetadata>(message.metadata)
  const steps = (metadata?.steps ?? [])
    .map((step) => `${step.status}:${step.step}`)
    .join("|")
  return [
    message.id,
    message.status,
    message.content.length,
    metadata?.explanation?.length ?? 0,
    steps,
  ].join(":")
}

function shouldDisplayPinnedProgressPlanMessage(
  message: ChatMessageResponse,
): boolean {
  if (message.role !== "SYSTEM" || message.kind !== "PLAN") {
    return false
  }
  if (message.status === "FAILED" || isEmptyPlanMessage(message)) {
    return false
  }

  const metadata = metadataAs<ChatPlanMetadata>(message.metadata)
  if (metadata?.presentation !== "progress") {
    return false
  }

  const steps = metadata.steps ?? []
  if (steps.length && steps.every((step) => planStepIsComplete(step.status))) {
    return false
  }

  return (
    steps.length > 0 ||
    isActiveMessage(message) ||
    !!normalizedPlanText(metadata.explanation) ||
    !!normalizedPlanText(message.content)
  )
}

function highlightedPlanStepIndex(steps: PlanStep[]): number {
  const activeIndex = steps.findIndex((step) => planStepIsActive(step.status))
  if (activeIndex >= 0) {
    return activeIndex
  }
  const pendingIndex = steps.findIndex(
    (step) => !planStepIsComplete(step.status),
  )
  if (pendingIndex >= 0) {
    return pendingIndex
  }
  return steps.length ? steps.length - 1 : -1
}

function pinnedPlanStatusLabel(
  message: ChatMessageResponse,
  steps: PlanStep[],
): string {
  if (
    steps.some((step) => planStepIsActive(step.status)) ||
    isActiveMessage(message)
  ) {
    return "in progress"
  }
  if (steps.length) {
    return "pending"
  }
  return "planning"
}

function PlanStepMarker({
  highlighted,
  status,
}: {
  highlighted: boolean
  status: string
}) {
  if (planStepIsComplete(status)) {
    return <Check className="mt-0.5 size-3.5 text-primary" />
  }
  if (planStepIsActive(status)) {
    return (
      <Loader2 className="mt-0.5 size-3.5 animate-spin text-muted-foreground" />
    )
  }
  return (
    <span
      className={cn(
        "mt-1.5 size-2 rounded-full",
        highlighted ? "bg-primary" : "bg-muted-foreground/35",
      )}
    />
  )
}

function planStepIsComplete(status: string): boolean {
  return ["complete", "completed", "done", "success", "succeeded"].includes(
    normalizedPlanStepStatus(status),
  )
}

function planStepIsActive(status: string): boolean {
  return [
    "active",
    "in_progress",
    "running",
    "started",
    "streaming",
    "working",
  ].includes(normalizedPlanStepStatus(status))
}

function planStepStatusLabel(status: string): string {
  return status.trim().replace(/[_-]+/g, " ").toLowerCase() || "pending"
}

function normalizedPlanStepStatus(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
}

function normalizedPlanText(value?: string | null): string | null {
  const text = value?.trim()
  if (!text) {
    return null
  }
  if (["...", "planning..."].includes(text.toLowerCase())) {
    return null
  }
  return text
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
              Describe what should be adjusted. Codex will revise the plan
              before implementing.
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
                {pending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <PencilLine />
                )}
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
      surroundingText: message.content
        .replace(PROPOSED_PLAN_ENVELOPE, "")
        .trim(),
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
            <Badge
              variant={metadata.exitCode === 0 ? "secondary" : "destructive"}
            >
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
    .find(
      (message) =>
        message.status === "STREAMING" || message.status === "PENDING",
    )
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

function PreviousActionsBlock({
  messages,
}: {
  messages: ChatMessageResponse[]
}) {
  return (
    <details className="group min-w-0 max-w-full overflow-hidden rounded-lg border bg-muted/20 text-sm">
      <summary className="grid min-w-0 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-muted-foreground">
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 shrink-0" />
          <span className="truncate">
            {messages.length} previous{" "}
            {messages.length === 1 ? "action" : "actions"}
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
  const metadata = metadataAs<
    ChatCommandMetadata | ChatApprovalMetadata | ChatUserInputMetadata
  >(message.metadata)
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
  const resolved =
    metadata?.status === "resolved" || message.status === "COMPLETED"
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
      <div
        className={cn(
          "flex items-center gap-2 font-medium",
          compact ? "mb-1.5" : "mb-2",
        )}
      >
        <LockKeyhole className="size-4" />
        {metadata?.requestKind === "permissions"
          ? "Permission request"
          : "Approval required"}
      </div>
      {metadata?.reason ? (
        <div
          className={cn("text-sm", compact ? "mb-1.5 line-clamp-2" : "mb-2")}
        >
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
                    ? {
                        kind: "permissions",
                        result: { scope: "turn", permissions: true },
                      }
                    : { decision: "accept", kind: "approval" },
                )
              }
            >
              {respond.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Check />
              )}
              Accept
            </Button>
            <Button
              disabled={respond.isPending}
              size="sm"
              variant="outline"
              onClick={() =>
                send(
                  metadata?.requestKind === "permissions"
                    ? {
                        kind: "permissions",
                        result: { scope: "session", permissions: true },
                      }
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
  const resolved =
    metadata?.status === "resolved" || message.status === "COMPLETED"
  const activeQuestionIndex = Math.min(
    questionIndex,
    Math.max(questions.length - 1, 0),
  )
  const currentQuestion = questions[activeQuestionIndex]
  const currentAnswered = currentQuestion
    ? readQuestionAnswerValues(currentQuestion, answers[currentQuestion.id])
        .length > 0
    : false
  const allAnswered = questions.every(
    (question) =>
      readQuestionAnswerValues(question, answers[question.id]).length > 0,
  )
  const isLastQuestion = activeQuestionIndex >= questions.length - 1
  const goToNextQuestion = () =>
    setQuestionIndex((current) => Math.min(current + 1, questions.length - 1))

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
            disabled={
              resolved || respond.isPending || activeQuestionIndex === 0
            }
            size="icon-xs"
            variant="ghost"
            onClick={() =>
              setQuestionIndex((current) => Math.max(current - 1, 0))
            }
          >
            <ArrowLeft />
          </Button>
          <Badge variant="secondary">
            {activeQuestionIndex + 1} / {questions.length}
          </Badge>
          <Button
            aria-label="Next question"
            disabled={
              resolved ||
              respond.isPending ||
              isLastQuestion ||
              !currentAnswered
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
            {respond.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Check />
            )}
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

function readResolvedUserInputAnswers(
  metadata: ChatUserInputMetadata,
): string[] {
  const result = metadata.result
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return []
  }
  const answerRoot = (result as { answers?: unknown }).answers
  if (
    !answerRoot ||
    typeof answerRoot !== "object" ||
    Array.isArray(answerRoot)
  ) {
    return []
  }
  return Object.entries(answerRoot)
    .map(([questionId, answerValue]) => {
      const question = metadata.questions?.find(
        (entry) => entry.id === questionId,
      )
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
                <span
                  className={cn(
                    "grid min-w-0 flex-1 overflow-hidden",
                    compact ? "gap-0.5" : "gap-1",
                  )}
                >
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
  return [
    ...values,
    ...(question.isOther || !question.options?.length ? [other] : []),
  ]
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
  return (
    <div className="min-w-0 whitespace-pre-wrap break-words text-sm text-muted-foreground">
      {text}
    </div>
  )
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

function readError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Request failed."
}
