import { verifyRequest } from "@/server/auth.server"
import {
  handleRouteError,
  jsonResponse,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import { readRateLimits } from "@/server/models.server"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await readRateLimits(requireParam(params, "accountId")))
  } catch (error) {
    return handleRouteError(error)
  }
}
