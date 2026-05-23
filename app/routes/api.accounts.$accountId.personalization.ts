import { verifyRequest } from "@/server/auth.server"
import {
  getAccountPersonalization,
  updateAccountPersonalization,
} from "@/server/accounts.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type { UpdateAccountPersonalizationRequest } from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(
      await getAccountPersonalization(requireParam(params, "accountId")),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["PATCH"])
    await verifyRequest(request)
    const body = await readJsonBody<UpdateAccountPersonalizationRequest>(request)
    if (typeof body.instructions !== "string") {
      throw new HttpError(400, "instructions is required.")
    }
    return jsonResponse(
      await updateAccountPersonalization(requireParam(params, "accountId"), {
        instructions: body.instructions,
      }),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
