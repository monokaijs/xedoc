import type { ApiDate } from './app';
import type {
  CodexCollaborationMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexServiceTier,
} from './codex';
import type { JsonSerializable } from './json';

export type ChatStatus = 'IDLE' | 'RUNNING' | 'ARCHIVED';
export type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';
export type MessageStatus = 'PENDING' | 'STREAMING' | 'COMPLETED' | 'FAILED';
export type MessageKind =
  | 'CHAT'
  | 'THINKING'
  | 'TOOL_ACTIVITY'
  | 'COMMAND_EXECUTION'
  | 'FILE_CHANGE'
  | 'PLAN'
  | 'APPROVAL'
  | 'USER_INPUT_PROMPT'
  | 'ERROR';
export type RunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface CreateChatRequest {
  accountId: string;
  autoRotateAccount?: boolean;
  workingDirectory: string;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  serviceTier?: CodexServiceTier | null;
  collaborationMode?: CodexCollaborationMode | null;
  permissionMode?: CodexPermissionMode | null;
  title?: string;
}

export interface UpdateChatRequest {
  accountId?: string | null;
  autoRotateAccount?: boolean;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  serviceTier?: CodexServiceTier | null;
  collaborationMode?: CodexCollaborationMode | null;
  permissionMode?: CodexPermissionMode | null;
  title?: string;
  workingDirectory?: string;
}

export interface ChatResponse {
  id: string;
  accountId?: string | null;
  autoRotateAccount: boolean;
  title: string;
  workingDirectory?: string | null;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  serviceTier?: CodexServiceTier | null;
  collaborationMode: CodexCollaborationMode;
  permissionMode: CodexPermissionMode;
  status: ChatStatus;
  externalThreadId?: string | null;
  lastActivityAt: ApiDate;
  lastSentAt: ApiDate;
  createdAt: ApiDate;
  updatedAt: ApiDate;
}

export interface ChatMessageResponse {
  id: string;
  chatId: string;
  runId?: string | null;
  sequence: number;
  role: MessageRole;
  kind: MessageKind;
  status: MessageStatus;
  turnId?: string | null;
  itemId?: string | null;
  requestId?: string | null;
  content: string;
  metadata?: ChatMessageMetadata | null;
  rawPayload?: JsonSerializable | null;
  createdAt: ApiDate;
  completedAt?: ApiDate | null;
}

export interface MessagePageResponse {
  data: ChatMessageResponse[];
  hasMoreBefore?: boolean;
  nextCursor?: number | null;
  previousCursor?: number | null;
}

export interface ExecuteChatRequest {
  content: string;
  accountId?: string;
  attachments?: ChatAttachmentInput[];
  collaborationMode?: CodexCollaborationMode | null;
  delivery?: ChatDeliveryMode;
  metadata?: Record<string, unknown>;
}

export interface ExecuteChatResponse {
  message: ChatMessageResponse;
  assistantMessage?: ChatMessageResponse | null;
  runId?: string | null;
  status: Extract<RunStatus, 'QUEUED' | 'RUNNING'>;
  delivery?: ChatDeliveryMode;
  queued?: boolean;
  steered?: boolean;
}

export type ChatDeliveryMode = 'queue' | 'steer';

export interface InterruptChatRunResponse {
  chatId: string;
  runId: string | null;
  status: Extract<RunStatus, 'QUEUED' | 'RUNNING' | 'CANCELLED'>;
  message: string;
}

export interface MessageDeltaPayload {
  messageId: string;
  runId: string;
  delta: string;
  content: string;
}

export interface RunStatusPayload {
  runId: string;
  status: RunStatus;
  error?: string;
}

export interface ContextWindowUsagePayload {
  tokensUsed: number;
  tokenLimit: number;
  tokensRemaining: number;
  usedPercent: number;
  remainingPercent: number;
}

export interface ChatContextResponse {
  usage?: ContextWindowUsagePayload | null;
}

export type ChatAttachmentKind = 'image' | 'file';

export type ChatAttachmentInput =
  | {
      kind: 'image';
      name?: string;
      mimeType?: string;
      size?: number;
      dataUrl: string;
    }
  | {
      kind: 'file';
      name?: string;
      path: string;
      size?: number;
    };

export type ChatMessageAttachment =
  | {
      id: string;
      kind: 'image';
      name: string;
      mimeType: string;
      size: number;
      url: string;
    }
  | {
      id: string;
      kind: 'file';
      name: string;
      path: string;
      size: number;
    };

export interface MessageFailedPayload extends ChatMessageResponse {
  error: string;
}

export interface ChatEventPayloads {
  'chat.updated': ChatResponse;
  'context.updated': ContextWindowUsagePayload;
  'message.created': ChatMessageResponse;
  'message.updated': ChatMessageResponse;
  'message.delta': MessageDeltaPayload;
  'message.completed': ChatMessageResponse;
  'message.failed': MessageFailedPayload;
  'run.status': RunStatusPayload;
}

export type ChatEventType = keyof ChatEventPayloads;

export type ServerRequestDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | JsonSerializable;

export interface ServerRequestResponseRequest {
  kind: 'approval' | 'permissions' | 'userInput';
  decision?: ServerRequestDecision;
  result?: JsonSerializable;
}

export type ChatMessageMetadata =
  | ChatCommandMetadata
  | ChatFileChangeMetadata
  | ChatPlanMetadata
  | ChatApprovalMetadata
  | ChatUserInputMetadata
  | ChatErrorMetadata
  | ChatGenericMetadata;

export interface ChatGenericMetadata {
  kind?: string;
  attachments?: ChatMessageAttachment[];
  [key: string]: JsonSerializable | undefined;
}

export interface ChatCommandMetadata {
  kind: 'command';
  callId?: string;
  command?: string;
  cwd?: string;
  status?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  actions?: JsonSerializable[];
}

export interface ChatFileChangeMetadata {
  kind: 'fileChange';
  status?: string;
  paths?: string[];
  changes?: JsonSerializable[];
  additions?: number;
  deletions?: number;
  diff?: string;
}

export interface ChatPlanMetadata {
  kind: 'plan';
  explanation?: string;
  steps?: ChatPlanStep[];
  presentation?: 'progress' | 'result';
}

export interface ChatPlanStep {
  step: string;
  status: string;
}

export interface ChatApprovalMetadata {
  kind: 'approval' | 'permissions';
  method: string;
  requestId: string;
  requestKind: 'approval' | 'permissions';
  status: 'pending' | 'resolved' | 'expired';
  reason?: string;
  command?: string;
  cwd?: string;
  itemId?: string;
  turnId?: string;
  changes?: JsonSerializable[];
  availableDecisions?: JsonSerializable[];
  autoApproved?: boolean;
  decision?: JsonSerializable;
  result?: JsonSerializable;
  resolvedAt?: string;
  raw?: JsonSerializable;
}

export interface ChatUserInputMetadata {
  kind: 'userInput';
  method: string;
  requestId: string;
  status: 'pending' | 'resolved' | 'expired';
  message?: string;
  mode?: string;
  questions?: ChatUserInputQuestion[];
  result?: JsonSerializable;
  resolvedAt?: string;
  raw?: JsonSerializable;
}

export interface ChatUserInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  selectionLimit?: number;
  options?: ChatUserInputOption[];
}

export interface ChatUserInputOption {
  label: string;
  description?: string;
}

export interface ChatErrorMetadata {
  kind: 'error';
  message: string;
  code?: string;
  details?: JsonSerializable;
}
