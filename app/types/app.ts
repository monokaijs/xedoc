export type ApiDate = string | Date;

export interface HealthResponse {
  status: string;
  service: string;
}

export interface AuthExchangeRequest {
  password: string;
}

export interface AuthExchangeResponse {
  token: string;
}

export interface AuthStatusResponse {
  passwordConfigured: boolean;
}

export interface AuthSessionResponse {
  authenticated: boolean;
  issuedAt: string;
}

export interface AuthTokenPayload {
  authHash: string;
  issuedAt: string;
}

export interface ClientSession {
  serverUrl: string;
  token: string;
}
