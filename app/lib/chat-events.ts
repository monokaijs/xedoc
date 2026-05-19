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
