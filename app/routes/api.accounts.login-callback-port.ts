import { verifyRequest } from "@/server/auth.server"
import {
  killLoginCallbackPortProcess,
  readLoginCallbackPortStatus,
} from "@/server/login-callback-port.server"
import {
  handleRouteError,
  jsonResponse,
  requireMethod,
} from "@/server/http.server"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await readLoginCallbackPortStatus())
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    return jsonResponse(await killLoginCallbackPortProcess())
  } catch (error) {
    return handleRouteError(error)
  }
}
