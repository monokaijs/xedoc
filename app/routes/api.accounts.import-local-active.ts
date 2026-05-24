import { verifyRequest } from "@/server/auth.server"
import { importLocalCodexActiveAccount } from "@/server/accounts.server"
import {
  handleRouteError,
  jsonResponse,
  requireMethod,
} from "@/server/http.server"

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    return jsonResponse(await importLocalCodexActiveAccount(), { status: 201 })
  } catch (error) {
    return handleRouteError(error)
  }
}