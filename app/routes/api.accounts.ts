import { verifyRequest } from "@/server/auth.server"
import { createAccount, listAccounts } from "@/server/accounts.server"
import {
  handleRouteError,
  jsonResponse,
  readJsonBody,
  readRecordField,
  readStringArrayField,
  readStringField,
  requireMethod,
} from "@/server/http.server"
import type { CreateAccountRequest } from "@/types"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await listAccounts())
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<CreateAccountRequest>(request)
    const dto: CreateAccountRequest = {
      displayName: readStringField(body.displayName, "displayName", {
        maxLength: 128,
      }),
      command: readStringField(body.command, "command"),
      args: readStringArrayField(body.args, "args"),
      defaultModel: readNullableRuntimeOption(body.defaultModel, "defaultModel"),
      defaultPermissionMode: readNullableRuntimeOption(
        body.defaultPermissionMode,
        "defaultPermissionMode",
      ) as CreateAccountRequest["defaultPermissionMode"],
      defaultReasoningEffort: readNullableRuntimeOption(
        body.defaultReasoningEffort,
        "defaultReasoningEffort",
      ) as CreateAccountRequest["defaultReasoningEffort"],
      defaultServiceTier: readNullableRuntimeOption(
        body.defaultServiceTier,
        "defaultServiceTier",
      ) as CreateAccountRequest["defaultServiceTier"],
      environment: readRecordField(body.environment, "environment") as
        | Record<string, string>
        | undefined,
    }
    return jsonResponse(await createAccount(dto), { status: 201 })
  } catch (error) {
    return handleRouteError(error)
  }
}

function readNullableRuntimeOption(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === null) {
    return null
  }
  return readStringField(value, field, { maxLength: 128 })
}
