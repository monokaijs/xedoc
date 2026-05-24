import { verifyRequest } from "@/server/auth.server"
import { setLocalCodexActiveAccount } from "@/server/accounts.server"
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
    return jsonResponse(
      await setLocalCodexActiveAccount(requireParam(params, "accountId")),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}