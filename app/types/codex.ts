export interface CodexRuntimeConfig {
  accountId: string;
  command: string;
  args: string[];
  workingDirectory?: string | null;
  environment?: Record<string, string> | null;
}

export type CodexReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export type CodexServiceTier = 'fast' | 'flex';

export type CodexCollaborationMode = 'default' | 'plan';

export type CodexPermissionMode = 'default' | 'fullAccess';

export interface CodexReasoningEffortOption {
  reasoningEffort: CodexReasoningEffort;
  description: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: CodexReasoningEffort;
  additionalSpeedTiers: string[];
  isDefault: boolean;
}

export interface CodexModelListResponse {
  data: CodexModelOption[];
  nextCursor?: string | null;
}

export type CodexPlanType =
  | 'free'
  | 'go'
  | 'plus'
  | 'pro'
  | 'prolite'
  | 'team'
  | 'self_serve_business_usage_based'
  | 'business'
  | 'enterprise_cbp_usage_based'
  | 'enterprise'
  | 'edu'
  | 'unknown';

export type CodexRateLimitReachedType =
  | 'rate_limit_reached'
  | 'workspace_owner_credits_depleted'
  | 'workspace_member_credits_depleted'
  | 'workspace_owner_usage_limit_reached'
  | 'workspace_member_usage_limit_reached';

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
}

export interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: CodexCreditsSnapshot | null;
  planType?: CodexPlanType | null;
  rateLimitReachedType?: CodexRateLimitReachedType | null;
}

export interface CodexRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot | undefined> | null;
}

export interface AccountRateLimitsResponse {
  data: Record<string, CodexRateLimitsResponse>;
  errors?: Record<string, string>;
  invalidatedAccountIds?: string[];
}

export interface CodexJsonRpcResponse {
  id?: string | number;
  result?: unknown;
  error?: { message?: string; code?: number };
  method?: string;
  params?: unknown;
}

export type CodexEventHandler = (message: CodexJsonRpcResponse) => void;
export type CodexServerRequestHandler = (message: CodexJsonRpcResponse) => void;

export interface CodexRuntimeSpawnConfig {
  command: string;
  args: string[];
  codexHome: string;
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: ['pipe', 'pipe', 'pipe'];
  };
}

export interface CodexPendingRequest {
  resolve: (response: CodexJsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
