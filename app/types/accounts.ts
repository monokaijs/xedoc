import type { ApiDate } from './app';
import type {
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexServiceTier,
} from './codex';
import type { JsonObject } from './json';

export type AccountStatus =
  | 'DISCONNECTED'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'INVALIDATED'
  | 'ERROR';

export type AccountAuthMode = 'browser' | 'device';

export interface CreateAccountRequest {
  displayName?: string;
  command?: string;
  args?: string[];
  environment?: Record<string, string>;
  defaultModel?: string | null;
  defaultPermissionMode?: CodexPermissionMode | null;
  defaultReasoningEffort?: CodexReasoningEffort | null;
  defaultServiceTier?: CodexServiceTier | null;
}

export type UpdateAccountRequest = Partial<CreateAccountRequest>;

export interface AccountResponse {
  id: string;
  displayName: string;
  status: AccountStatus;
  isLocalCodexActive?: boolean;
  command: string;
  args: string[];
  environment?: Record<string, string> | null;
  defaultModel?: string | null;
  defaultPermissionMode?: CodexPermissionMode | null;
  defaultReasoningEffort?: CodexReasoningEffort | null;
  defaultServiceTier?: CodexServiceTier | null;
  lastAuthUrl?: string | null;
  lastAuthMode?: AccountAuthMode | null;
  lastAuthLoginId?: string | null;
  lastAuthUserCode?: string | null;
  lastError?: string | null;
  createdAt: ApiDate;
  updatedAt: ApiDate;
}

export interface AccountAuthExport {
  authJson: JsonObject;
}

export interface AccountExportEntry {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  auth?: AccountAuthExport | null;
  environment?: Record<string, string> | null;
  defaultModel?: string | null;
  defaultPermissionMode?: CodexPermissionMode | null;
  defaultReasoningEffort?: CodexReasoningEffort | null;
  defaultServiceTier?: CodexServiceTier | null;
  createdAt: ApiDate;
  updatedAt: ApiDate;
}

export interface AccountExportDocument {
  schemaVersion: 2;
  exportedAt: ApiDate;
  accounts: AccountExportEntry[];
}

export interface AccountImportEntry {
  id?: string;
  displayName: string;
  command?: string;
  args?: string[];
  auth?: AccountAuthExport | null;
  environment?: Record<string, string> | null;
  defaultModel?: string | null;
  defaultPermissionMode?: CodexPermissionMode | null;
  defaultReasoningEffort?: CodexReasoningEffort | null;
  defaultServiceTier?: CodexServiceTier | null;
}

export interface AccountRuntimeSettingsRequest {
  defaultModel?: string | null;
  defaultPermissionMode?: CodexPermissionMode | null;
  defaultReasoningEffort?: CodexReasoningEffort | null;
  defaultServiceTier?: CodexServiceTier | null;
}

export interface AccountPersonalizationResponse {
  accountId: string | null;
  codexHome: string;
  instructionsPath: string;
  instructions: string;
  maxBytes: number;
  shared: boolean;
}

export interface UpdateAccountPersonalizationRequest {
  instructions: string;
}

export interface LoginCallbackPortProcess {
  pid: number;
  command?: string;
  user?: string;
  address?: string;
}

export interface LoginCallbackPortStatus {
  checkedAt: ApiDate;
  host: string;
  port: number;
  inUse: boolean;
  killable: boolean;
  processes: LoginCallbackPortProcess[];
  killedProcessIds?: number[];
  message?: string;
}

export interface ImportAccountsRequest {
  accounts: AccountImportEntry[];
}

export interface ImportAccountsResponse {
  imported: number;
  accounts: AccountResponse[];
  authentications: AuthenticateAccountResponse[];
}

export interface AuthenticateAccountRequest {
  mode?: AccountAuthMode;
}

export interface AuthenticateAccountResponse {
  accountId: string;
  status: Extract<AccountStatus, 'AUTHENTICATING' | 'CONNECTED' | 'ERROR'>;
  authMode?: AccountAuthMode | null;
  authUrl?: string | null;
  verificationUrl?: string | null;
  userCode?: string | null;
  loginId?: string | null;
  message?: string;
}

export interface CompleteAccountLoginRequest {
  redirectUrl: string;
}
