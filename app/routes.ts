import {
  index,
  layout,
  route,
  type RouteConfig,
} from "@react-router/dev/routes"

export default [
  route("connect", "routes/connect.tsx"),
  route("favicon.ico", "routes/favicon.ico.ts"),
  layout("routes/app-layout.tsx", [
    index("routes/home.tsx"),
    route("chat/:chatId", "routes/chat.tsx"),
    route("workflow", "routes/workflow.tsx"),
  ]),
  route("health", "routes/health.ts"),
  route("api/auth/status", "routes/api.auth.status.ts"),
  route("api/auth/exchange", "routes/api.auth.exchange.ts"),
  route("api/auth/session", "routes/api.auth.session.ts"),
  route("api/accounts", "routes/api.accounts.ts"),
  route("api/accounts/export", "routes/api.accounts.export.ts"),
  route("api/accounts/import", "routes/api.accounts.import.ts"),
  route(
    "api/accounts/import-local-active",
    "routes/api.accounts.import-local-active.ts",
  ),
  route(
    "api/accounts/login-callback-port",
    "routes/api.accounts.login-callback-port.ts",
  ),
  route(
    "api/accounts/:accountId/local-active",
    "routes/api.accounts.$accountId.local-active.ts",
  ),
  route("api/accounts/:accountId", "routes/api.accounts.$accountId.ts"),
  route(
    "api/accounts/:accountId/runtime-settings",
    "routes/api.accounts.$accountId.runtime-settings.ts",
  ),
  route("api/accounts/:accountId/models", "routes/api.accounts.$accountId.models.ts"),
  route(
    "api/accounts/:accountId/rate-limits",
    "routes/api.accounts.$accountId.rate-limits.ts",
  ),
  route(
    "api/accounts/:accountId/authenticate",
    "routes/api.accounts.$accountId.authenticate.ts",
  ),
  route(
    "api/accounts/:accountId/authenticate/callback",
    "routes/api.accounts.$accountId.authenticate.callback.ts",
  ),
  route("api/chats", "routes/api.chats.ts"),
  route("api/chats/:chatId", "routes/api.chats.$chatId.ts"),
  route("api/chats/:chatId/context", "routes/api.chats.$chatId.context.ts"),
  route("api/chats/:chatId/files", "routes/api.chats.$chatId.files.ts"),
  route(
    "api/chats/:chatId/git/:operation",
    "routes/api.chats.$chatId.git.$operation.ts",
  ),
  route("api/chats/:chatId/messages", "routes/api.chats.$chatId.messages.ts"),
  route("api/chats/:chatId/interrupt", "routes/api.chats.$chatId.interrupt.ts"),
  route(
    "api/chats/:chatId/queued/:queueId/steer",
    "routes/api.chats.$chatId.queued.$queueId.steer.ts",
  ),
  route(
    "api/chats/:chatId/server-requests/:requestId/respond",
    "routes/api.chats.$chatId.server-requests.$requestId.respond.ts",
  ),
  route("api/workflow/tasks", "routes/api.workflow.tasks.ts"),
  route(
    "api/workflow/tasks/:taskId",
    "routes/api.workflow.tasks.$taskId.ts",
  ),
  route("api/workspaces/directories", "routes/api.workspaces.directories.ts"),
] satisfies RouteConfig
