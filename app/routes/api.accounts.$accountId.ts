import { verifyRequest } from "@/server/auth.server"
import {
  deleteAccount,
  getAccount,
  updateAccount,
} from "@/server/accounts.server"
import {
  handleRouteError,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
  readRecordField,
  readStringArrayField,
  readStringField,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type { UpdateAccountRequest } from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await getAccount(requireParam(params, "accountId")))
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request, params }: RouteArgs) {
  try {
    await verifyRequest(request)
    const accountId = requireParam(params, "accountId")
    if (request.method === "PATCH") {
      const body = await readJsonBody<UpdateAccountRequest>(request)
      const dto: UpdateAccountRequest = {
        displayName: readStringField(body.displayName, "displayName", {
          maxLength: 128,
        }),
        command: readStringField(body.command, "command"),
        args: readStringArrayField(body.args, "args"),
        environment: readRecordField(body.environment, "environment") as
          | Record<string, string>
          | undefined,
      }
      return jsonResponse(await updateAccount(accountId, dto))
    }
    if (request.method === "DELETE") {
      return jsonResponse(await deleteAccount(accountId))
    }
    methodNotAllowed(request.method)
  } catch (error) {
    return handleRouteError(error)
  }
}
