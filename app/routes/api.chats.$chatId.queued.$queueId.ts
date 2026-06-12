import { verifyRequest } from "@/server/auth.server"
import { removeQueuedMessage } from "@/server/chats.server"
import {
  handleRouteError,
  jsonResponse,
  requireMethod,
  requireParam,
} from "@/server/http.server"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function action({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["DELETE"])
    await verifyRequest(request)
    return jsonResponse(
      await removeQueuedMessage(
        requireParam(params, "chatId"),
        requireParam(params, "queueId"),
      ),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
