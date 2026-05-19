import { jsonResponse, requireMethod, handleRouteError } from "@/server/http.server"

export function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    return jsonResponse({ status: "ok", service: "xedoc" })
  } catch (error) {
    return handleRouteError(error)
  }
}
