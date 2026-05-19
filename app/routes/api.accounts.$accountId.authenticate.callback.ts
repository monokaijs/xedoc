import { verifyRequest } from "@/server/auth.server"
import { completeAuthentication } from "@/server/accounts.server"
import {
  handleRouteError,
  jsonResponse,
  readJsonBody,
  readStringField,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type { CompleteAccountLoginRequest } from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function action({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<CompleteAccountLoginRequest>(request)
    const redirectUrl = readStringField(body.redirectUrl, "redirectUrl", {
      required: true,
      maxLength: 4096,
    })
    return jsonResponse(
      await completeAuthentication(requireParam(params, "accountId"), redirectUrl),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
