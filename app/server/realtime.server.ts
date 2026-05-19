import type {
  ChatEventPayloads,
  ChatEventType,
  ChatRealtimeEvent,
} from "@/types"

type RealtimeHandler = (event: ChatRealtimeEvent) => void
type RealtimeState = {
  handlers: Set<RealtimeHandler>
}

const REALTIME_STATE_KEY = "__xedocRealtimeState__"

export function publishChatEvent<TType extends ChatEventType>(
  chatId: string,
  type: TType,
  payload: ChatEventPayloads[TType],
): void {
  const event: ChatRealtimeEvent = { chatId, type, payload }
  for (const handler of getRealtimeState().handlers) {
    handler(event)
  }
}

export function subscribePublishedChatEvents(
  handler: RealtimeHandler,
): () => void {
  const state = getRealtimeState()
  state.handlers.add(handler)
  return () => state.handlers.delete(handler)
}

function getRealtimeState(): RealtimeState {
  const globalValue = globalThis as typeof globalThis & {
    [REALTIME_STATE_KEY]?: RealtimeState
  }
  globalValue[REALTIME_STATE_KEY] ??= { handlers: new Set() }
  return globalValue[REALTIME_STATE_KEY]
}
