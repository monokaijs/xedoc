import { verifyRequest } from "@/server/auth.server"
import {
  handleRouteError,
  jsonResponse,
  requireMethod,
} from "@/server/http.server"
import { readConnectedAccountRateLimits } from "@/server/models.server"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await readConnectedAccountRateLimits())
  } catch (error) {
    return handleRouteError(error)
  }
}
