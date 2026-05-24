import type {
  ChatApprovalMetadata,
  ChatCommandMetadata,
  ChatMessageAttachment,
  ChatMessageMetadata,
  ChatMessageResponse,
  ChatPlanMetadata,
  ChatUserInputMetadata,
} from "@/types"
import { Code2, ListChecks, LockKeyhole, Terminal } from "lucide-react"
import type { ReactNode } from "react"

export type TimelineEntry =
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

export type CodexRenderItem =
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

export function projectCodexRenderItems(
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
  | {
      messages: ChatMessageResponse[]
      sequence: number
      type: "previousActions"
    }
  | { messages: ChatMessageResponse[]; sequence: number; type: "fileChanges" }

function collapseCompletedTurnActions(
  messages: ChatMessageResponse[],
): CodexRenderSourceItem[] {
  const active = messages.some(isActiveMessage)
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

  const sourceItems: CodexRenderSourceItem[] = visibleMessages.map(
    (message) => ({
      message,
      sequence: message.sequence,
      type: "message" as const,
    }),
  )
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
      if (isActiveMessage(item.message)) {
        flushPending()
        projected.push({
          id: `message:${item.message.id}`,
          message: item.message,
          type: "message",
        })
        continue
      }

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
    const turnKey = message.turnId
      ? `turn:${message.turnId}`
      : `message:${message.id}`
    const group = groups.get(turnKey)
    if (group) {
      group.push(message)
    } else {
      groups.set(turnKey, [message])
    }
  }

  return Array.from(groups.values()).flatMap((group) => {
    const active = group.some(isActiveMessage)
    if (active) {
      return group
    }
    return [
      ...group.filter((message) => message.kind !== "FILE_CHANGE"),
      ...group.filter((message) => message.kind === "FILE_CHANGE"),
    ]
  })
}

export function collapseDuplicateTimelineMessages(
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
    if (
      messageStatusPriority(next.status) >
      messageStatusPriority(existing.status)
    ) {
      return { ...existing, status: next.status }
    }
    return existing
  }

  if (
    messageStatusPriority(next.status) > messageStatusPriority(existing.status)
  ) {
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

export function groupTimelineEntries(
  messages: ChatMessageResponse[],
): TimelineEntry[] {
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
      if (isActiveMessage(message)) {
        flushAssistantChat()
        compacted.push(message)
        continue
      }
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

export function mergeMessageStatus(
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

export function isActiveMessage(message: ChatMessageResponse): boolean {
  return message.status === "STREAMING" || message.status === "PENDING"
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

export function isHiddenTimelineMessage(message: ChatMessageResponse): boolean {
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

export function isEmptyPlanMessage(message: ChatMessageResponse): boolean {
  if (message.kind !== "PLAN") {
    return false
  }
  const metadata = metadataAs<ChatPlanMetadata>(message.metadata)
  return (
    message.content.trim().length === 0 &&
    !metadata?.explanation?.trim() &&
    !metadata?.steps?.length
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
  if (
    message.kind === "ERROR" ||
    message.kind === "FILE_CHANGE" ||
    message.kind === "PLAN"
  ) {
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
    return (
      !!finalAssistant &&
      finalAssistant.content.includes(message.content.trim())
    )
  }
  return false
}

function isToolBurstCandidate(message: ChatMessageResponse): boolean {
  return (
    message.kind === "COMMAND_EXECUTION" || message.kind === "TOOL_ACTIVITY"
  )
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

export function uniqueMessages(
  messages: ChatMessageResponse[],
): ChatMessageResponse[] {
  const seen = new Set<string>()
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false
    }
    seen.add(message.id)
    return true
  })
}

export function compactActionLabel(
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

export function compactActionIcon(message: ChatMessageResponse): ReactNode {
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

export function metadataAs<TMetadata extends ChatMessageMetadata>(
  metadata: ChatMessageResponse["metadata"],
): TMetadata | undefined {
  return metadata && typeof metadata === "object"
    ? (metadata as TMetadata)
    : undefined
}

export function messageAttachments(
  message: ChatMessageResponse,
): ChatMessageAttachment[] {
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
