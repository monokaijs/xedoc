import { verifyRequest } from "@/server/auth.server"
import {
  getSharedAccountPersonalization,
  updateSharedAccountPersonalization,
} from "@/server/accounts.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  requireMethod,
} from "@/server/http.server"
import type { UpdateAccountPersonalizationRequest } from "@/types"

type RouteArgs = {
  request: Request
}

export async function loader({ request }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await getSharedAccountPersonalization())
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request }: RouteArgs) {
  try {
    requireMethod(request, ["PATCH"])
    await verifyRequest(request)
    const body = await readJsonBody<UpdateAccountPersonalizationRequest>(request)
    if (typeof body.instructions !== "string") {
      throw new HttpError(400, "instructions is required.")
    }
    return jsonResponse(
      await updateSharedAccountPersonalization({ instructions: body.instructions }),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}