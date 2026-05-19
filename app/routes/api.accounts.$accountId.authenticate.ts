import { verifyRequest } from "@/server/auth.server"
import { authenticateAccount } from "@/server/accounts.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  readStringField,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type { AccountAuthMode, AuthenticateAccountRequest } from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function action({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<AuthenticateAccountRequest>(request)
    return jsonResponse(
      await authenticateAccount(
        requireParam(params, "accountId"),
        readAccountAuthMode(body.mode),
      ),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

function readAccountAuthMode(value: unknown): AccountAuthMode | undefined {
  const mode = readStringField(value, "mode", { maxLength: 16 })
  if (mode === undefined || mode === "browser" || mode === "device") {
    return mode
  }
  throw new HttpError(400, "mode must be browser or device.")
}
