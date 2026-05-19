import { verifyRequest } from "@/server/auth.server"
import { respondToCodexServerRequest } from "@/server/chats.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type { ServerRequestResponseRequest } from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function action({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<ServerRequestResponseRequest>(request)
    const kind = readRequestKind(body.kind)
    return jsonResponse(
      await respondToCodexServerRequest(
        requireParam(params, "chatId"),
        requireParam(params, "requestId"),
        {
          decision: body.decision,
          kind,
          result: body.result,
        },
      ),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

function readRequestKind(value: unknown): ServerRequestResponseRequest["kind"] {
  if (value === "approval" || value === "permissions" || value === "userInput") {
    return value
  }
  throw new HttpError(400, "kind must be approval, permissions, or userInput.")
}
