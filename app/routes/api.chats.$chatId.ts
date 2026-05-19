import { verifyRequest } from "@/server/auth.server"
import { archiveChat, getChat, updateChat } from "@/server/chats.server"
import {
  handleRouteError,
  jsonResponse,
  methodNotAllowed,
  readBooleanField,
  readJsonBody,
  readStringField,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type {
  CodexCollaborationMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexServiceTier,
  UpdateChatRequest,
} from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await getChat(requireParam(params, "chatId")))
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request, params }: RouteArgs) {
  try {
    await verifyRequest(request)
    const chatId = requireParam(params, "chatId")
    if (request.method === "PATCH") {
      const body = await readJsonBody<UpdateChatRequest>(request)
      const dto: UpdateChatRequest = {
        accountId: readStringField(body.accountId, "accountId"),
        autoRotateAccount: readBooleanField(
          body.autoRotateAccount,
          "autoRotateAccount",
        ),
        model:
          body.model === null
            ? null
            : readStringField(body.model, "model", { maxLength: 160 }),
        reasoningEffort: readRuntimeOption(
          body.reasoningEffort,
          "reasoningEffort",
        ) as CodexReasoningEffort | null | undefined,
        serviceTier: readRuntimeOption(body.serviceTier, "serviceTier") as
          | CodexServiceTier
          | null
          | undefined,
        collaborationMode: readRuntimeOption(
          body.collaborationMode,
          "collaborationMode",
        ) as CodexCollaborationMode | null | undefined,
        permissionMode: readRuntimeOption(
          body.permissionMode,
          "permissionMode",
        ) as CodexPermissionMode | null | undefined,
        title: readStringField(body.title, "title", { maxLength: 160 }),
        workingDirectory: readStringField(
          body.workingDirectory,
          "workingDirectory",
          { maxLength: 4096 },
        ),
      }
      return jsonResponse(await updateChat(chatId, dto))
    }
    if (request.method === "DELETE") {
      return jsonResponse(await archiveChat(chatId))
    }
    methodNotAllowed(request.method)
  } catch (error) {
    return handleRouteError(error)
  }
}

function readRuntimeOption(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === null) {
    return null
  }
  return readStringField(value, field, { maxLength: 80 })
}
