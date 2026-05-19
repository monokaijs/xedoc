import { exchangePassword } from "@/server/auth.server"
import {
  handleRouteError,
  jsonResponse,
  readJsonBody,
  readStringField,
  requireMethod,
} from "@/server/http.server"
import type { AuthExchangeRequest } from "@/types"

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    const body = await readJsonBody<AuthExchangeRequest>(request)
    const password = readStringField(body.password, "password", {
      required: true,
      maxLength: 256,
    })
    return jsonResponse(await exchangePassword(password), { status: 200 })
  } catch (error) {
    return handleRouteError(error)
  }
}
