import { verifyRequest } from "@/server/auth.server"
import { interruptChatRun } from "@/server/chats.server"
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
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    return jsonResponse(await interruptChatRun(requireParam(params, "chatId")))
  } catch (error) {
    return handleRouteError(error)
  }
}
