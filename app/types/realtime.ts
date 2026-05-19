import type { ChatEventPayloads, ChatEventType } from './chats';

export interface ChatRealtimeEvent {
  chatId: string;
  type: ChatEventType;
  payload: ChatEventPayloads[ChatEventType];
}
