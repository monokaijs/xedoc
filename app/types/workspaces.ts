export type WorkspaceEntryType = 'directory' | 'file' | 'symlink';

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: WorkspaceEntryType;
}

export interface WorkspaceDirectoryResponse {
  root: string;
  path: string;
  parentPath?: string | null;
  entries: WorkspaceEntry[];
}

export interface CreateWorkspaceDirectoryRequest {
  parentPath: string;
  name: string;
}

export interface WorkspaceFileResponse {
  content?: string;
  isBinary: boolean;
  language?: string | null;
  line?: number | null;
  lineCount: number;
  name: string;
  path: string;
  relativePath: string;
  size: number;
  truncated: boolean;
}

export interface GitFileStatus {
  path: string;
  status: string;
  staged: string;
  unstaged: string;
}

export interface GitStatusResponse {
  ahead: number;
  behind: number;
  branch?: string | null;
  changedFiles: GitFileStatus[];
  clean: boolean;
  isRepo: boolean;
  root?: string | null;
  upstream?: string | null;
}

export interface GitBranch {
  current: boolean;
  name: string;
}

export interface GitBranchesResponse {
  branches: GitBranch[];
  current?: string | null;
  defaultBranch?: string | null;
  isRepo: boolean;
}

export interface GitDiffResponse {
  diff: string;
  isRepo: boolean;
  path?: string | null;
  stat: string;
}

export type GitActionType =
  | 'checkout'
  | 'createBranch'
  | 'commit'
  | 'pull'
  | 'push';

export interface GitActionRequest {
  action: GitActionType;
  branch?: string;
  message?: string;
}

export interface GitActionResponse {
  message: string;
  output?: string;
  status: GitStatusResponse;
}
