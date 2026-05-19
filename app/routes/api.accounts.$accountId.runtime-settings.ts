import { verifyRequest } from "@/server/auth.server"
import { updateAccountRuntimeSettings } from "@/server/accounts.server"
import {
  handleRouteError,
  jsonResponse,
  readJsonBody,
  readStringField,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type { AccountRuntimeSettingsRequest } from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function action({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["PATCH"])
    await verifyRequest(request)
    const body = await readJsonBody<AccountRuntimeSettingsRequest>(request)
    const dto: AccountRuntimeSettingsRequest = {
      defaultModel: readNullableRuntimeOption(body.defaultModel, "defaultModel"),
      defaultPermissionMode: readNullableRuntimeOption(
        body.defaultPermissionMode,
        "defaultPermissionMode",
      ) as AccountRuntimeSettingsRequest["defaultPermissionMode"],
      defaultReasoningEffort: readNullableRuntimeOption(
        body.defaultReasoningEffort,
        "defaultReasoningEffort",
      ) as AccountRuntimeSettingsRequest["defaultReasoningEffort"],
      defaultServiceTier: readNullableRuntimeOption(
        body.defaultServiceTier,
        "defaultServiceTier",
      ) as AccountRuntimeSettingsRequest["defaultServiceTier"],
    }
    return jsonResponse(
      await updateAccountRuntimeSettings(requireParam(params, "accountId"), dto),
    )
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
