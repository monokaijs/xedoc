import type { ApiDate } from './app';

export type WorkflowTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'finished'
  | 'failed';

export interface WorkflowTaskResponse {
  id: string;
  projectPath: string;
  projectName: string;
  title: string;
  description: string;
  status: WorkflowTaskStatus;
  createdAt: ApiDate;
  updatedAt: ApiDate;
}

export interface CreateWorkflowTaskRequest {
  projectPath: string;
  title: string;
  description?: string;
  status?: WorkflowTaskStatus;
}

export interface UpdateWorkflowTaskRequest {
  projectPath?: string;
  title?: string;
  description?: string;
  status?: WorkflowTaskStatus;
}
