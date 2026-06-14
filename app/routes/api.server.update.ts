import { verifyRequest } from "@/server/auth.server"
import {
  readServerUpdateStatus,
  updateServerPackage,
} from "@/server/update.server"
import {
  handleRouteError,
  jsonResponse,
  readBooleanField,
  readJsonBody,
  requireMethod,
} from "@/server/http.server"
import type { ServerUpdateRequest } from "@/types"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await readServerUpdateStatus())
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<ServerUpdateRequest>(request)
    return jsonResponse(
      await updateServerPackage({
        force: readBooleanField(body.force, "force") ?? false,
      }),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
