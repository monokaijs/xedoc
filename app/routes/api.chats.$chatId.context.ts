import { verifyRequest } from "@/server/auth.server"
import { readChatContext } from "@/server/chats.server"
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

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await readChatContext(requireParam(params, "chatId")))
  } catch (error) {
    return handleRouteError(error)
  }
}
