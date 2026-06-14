import type { ApiDate } from "./app"

export interface ServerUpdateStatusResponse {
  packageName: string
  currentVersion: string
  latestVersion?: string | null
  updateAvailable: boolean
  checkedAt: ApiDate
  registryUrl: string
  canUpdate: boolean
  installCommand: string
  restartRequired: boolean
  message?: string | null
  lastError?: string | null
}

export interface ServerUpdateRequest {
  force?: boolean
}

export interface ServerUpdateResponse extends ServerUpdateStatusResponse {
  restartScheduled: boolean
}
