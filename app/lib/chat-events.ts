import type {
  ChatMessageResponse,
  ChatEventPayloads,
  ChatEventType,
  MessagePageResponse,
} from "@/types"
import { appendMessage } from "./api"

export function applyChatEvent<TType extends ChatEventType>(
  page: MessagePageResponse | undefined,
  type: TType,
  payload: ChatEventPayloads[TType],
): MessagePageResponse | undefined {
  if (
    type === "message.created" ||
    type === "message.updated" ||
    type === "message.completed"
  ) {
    return appendMessage(page, payload as ChatMessageResponse)
  }

  if (type === "message.failed") {
    return appendMessage(page, payload as ChatMessageResponse)
  }

  if (type === "message.delta") {
    const delta = payload as ChatEventPayloads["message.delta"]
    if (!page) {
      return page
    }
    return {
      ...page,
      data: page.data.map((message) =>
        message.id === delta.messageId
          ? { ...message, content: delta.content, status: "STREAMING" }
          : message,
      ),
    }
  }

  return page
}

export function highestSequence(page: MessagePageResponse | undefined): number {
  return Math.max(0, ...(page?.data.map((message) => message.sequence) ?? []))
}

export function mergeMessagePage(
  previous: MessagePageResponse | undefined,
  next: MessagePageResponse,
): MessagePageResponse {
  if (!previous?.data.length) {
    return next
  }

  const merged = [...next.data]
  for (const message of previous.data) {
    if (!messageIsRepresented(message, merged)) {
      merged.push(message)
    }
  }
  const data = merged.sort(compareMessages)
  const previousMinSequence = minSequence(previous.data)
  const nextMinSequence = minSequence(next.data)
  const loadedOlderPage =
    previousMinSequence !== null &&
    nextMinSequence !== null &&
    nextMinSequence < previousMinSequence

  const nextCursor = Math.max(
    0,
    previous.nextCursor ?? 0,
    next.nextCursor ?? 0,
    ...data.map((message) => message.sequence),
  )
  const previousCursor = minSequence(data)

  return {
    data,
    hasMoreBefore: loadedOlderPage
      ? next.hasMoreBefore ?? false
      : previous.hasMoreBefore ?? next.hasMoreBefore ?? false,
    nextCursor: nextCursor || null,
    previousCursor,
  }
}

function minSequence(messages: ChatMessageResponse[]): number | null {
  return messages.length
    ? Math.min(...messages.map((message) => message.sequence))
    : null
}

function messageIsRepresented(
  candidate: ChatMessageResponse,
  messages: ChatMessageResponse[],
): boolean {
  return messages.some(
    (message) =>
      message.id === candidate.id ||
      messagesRepresentSameEntry(message, candidate),
  )
}

function messagesRepresentSameEntry(
  next: ChatMessageResponse,
  previous: ChatMessageResponse,
): boolean {
  if (
    next.chatId !== previous.chatId ||
    next.role !== previous.role ||
    next.kind !== previous.kind
  ) {
    return false
  }

  if (next.requestId && previous.requestId) {
    return next.requestId === previous.requestId && sameMessageScope(next, previous)
  }
  if (next.itemId && previous.itemId) {
    return next.itemId === previous.itemId && sameMessageScope(next, previous)
  }

  if (next.kind !== "CHAT") {
    return false
  }

  const nextContent = normalizedContent(next.content)
  const previousContent = normalizedContent(previous.content)
  if (!nextContent || !previousContent) {
    return false
  }
  if (nextContent === previousContent) {
    return true
  }
  return isActive(previous) && nextContent.includes(previousContent)
}

function sameMessageScope(
  next: ChatMessageResponse,
  previous: ChatMessageResponse,
): boolean {
  if (next.runId && previous.runId && next.runId !== previous.runId) {
    return false
  }
  if (next.runId && previous.runId) {
    return true
  }
  if (next.turnId && previous.turnId && next.turnId !== previous.turnId) {
    return false
  }
  if ((next.runId || previous.runId) && !(next.turnId && previous.turnId)) {
    return false
  }
  return true
}

function normalizedContent(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function isActive(message: ChatMessageResponse): boolean {
  return message.status === "PENDING" || message.status === "STREAMING"
}

function compareMessages(
  left: ChatMessageResponse,
  right: ChatMessageResponse,
): number {
  return (
    left.sequence - right.sequence ||
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
    left.id.localeCompare(right.id)
  )
}
