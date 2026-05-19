import { readSession } from "@/server/auth.server"
import { handleRouteError, jsonResponse, requireMethod } from "@/server/http.server"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    return jsonResponse(await readSession(request))
  } catch (error) {
    return handleRouteError(error)
  }
}
