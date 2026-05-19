import { verifyRequest } from "@/server/auth.server"
import { exportAccounts } from "@/server/accounts.server"
import {
  handleRouteError,
  jsonResponse,
  requireMethod,
} from "@/server/http.server"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await exportAccounts())
  } catch (error) {
    return handleRouteError(error)
  }
}
