import { verifyRequest } from "@/server/auth.server"
import { createChat, listChats } from "@/server/chats.server"
import {
  handleRouteError,
  jsonResponse,
  readBooleanField,
  readJsonBody,
  readStringField,
  requireMethod,
} from "@/server/http.server"
import type {
  CodexCollaborationMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexServiceTier,
  CreateChatRequest,
} from "@/types"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await listChats())
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<CreateChatRequest>(request)
    const dto: CreateChatRequest = {
      accountId: readStringField(body.accountId, "accountId", {
        required: true,
      }),
      autoRotateAccount: readBooleanField(
        body.autoRotateAccount,
        "autoRotateAccount",
      ),
      workingDirectory: readStringField(
        body.workingDirectory,
        "workingDirectory",
        { required: true, maxLength: 4096 },
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
    }
    return jsonResponse(await createChat(dto), { status: 201 })
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
