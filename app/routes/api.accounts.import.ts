import { verifyRequest } from "@/server/auth.server"
import { importAccounts } from "@/server/accounts.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  requireMethod,
} from "@/server/http.server"
import type { ImportAccountsRequest } from "@/types"

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<ImportAccountsRequest>(request)
    if (!Array.isArray(body.accounts)) {
      throw new HttpError(400, "accounts must be an array.")
    }
    const dto: ImportAccountsRequest = {
      accounts: body.accounts,
    }
    return jsonResponse(await importAccounts(dto), { status: 201 })
  } catch (error) {
    return handleRouteError(error)
  }
}
