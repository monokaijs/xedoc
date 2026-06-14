import { verifyRequest } from "@/server/auth.server"
import { executeMessage, listMessages } from "@/server/chats.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  readNumberQuery,
  readRecordField,
  readStringField,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type {
  ChatDeliveryMode,
  CodexCollaborationMode,
  ExecuteChatRequest,
} from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    const url = new URL(request.url)
    return jsonResponse(
      await listMessages(
        requireParam(params, "chatId"),
        {
          afterSequence: readNumberQuery(url, "afterSequence", 0),
          beforeSequence: readNumberQuery(url, "beforeSequence", 0),
          limit: readNumberQuery(url, "limit", 1000),
        },
      ),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<ExecuteChatRequest>(request)
    const dto: ExecuteChatRequest = {
      content: readMessageContent(body.content),
      accountId: readStringField(body.accountId, "accountId"),
      attachments: readAttachmentInputs(body.attachments),
      collaborationMode: readRuntimeOption(
        body.collaborationMode,
        "collaborationMode",
      ) as CodexCollaborationMode | null | undefined,
      delivery: readDeliveryMode(body.delivery),
      metadata: readRecordField(body.metadata, "metadata"),
    }
    return jsonResponse(
      await executeMessage(requireParam(params, "chatId"), dto),
      { status: 201 },
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

function readDeliveryMode(value: unknown): ChatDeliveryMode | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (value === "queue" || value === "steer") {
    return value
  }
  throw new HttpError(400, "delivery is invalid.")
}

function readMessageContent(value: unknown): string {
  if (value === undefined || value === null) {
    return ""
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "content must be a string.")
  }
  if (value.length > 40_000) {
    throw new HttpError(400, "content must be 40000 characters or fewer.")
  }
  return value.trim()
}

function readAttachmentInputs(value: unknown): ExecuteChatRequest["attachments"] {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "attachments must be an array.")
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HttpError(400, `attachments[${index}] must be an object.`)
    }
    const object = entry as Record<string, unknown>
    if (object.kind === "image") {
      return {
        kind: "image" as const,
        dataUrl: readRequiredString(object.dataUrl, `attachments[${index}].dataUrl`, 8_500_000),
        mimeType: readOptionalString(object.mimeType, `attachments[${index}].mimeType`, 80),
        name: readOptionalString(object.name, `attachments[${index}].name`, 160),
        size: readOptionalNumber(object.size, `attachments[${index}].size`),
      }
    }
    if (object.kind === "file") {
      return {
        kind: "file" as const,
        name: readOptionalString(object.name, `attachments[${index}].name`, 160),
        path: readRequiredString(object.path, `attachments[${index}].path`, 4096),
        size: readOptionalNumber(object.size, `attachments[${index}].size`),
      }
    }
    throw new HttpError(400, `attachments[${index}].kind is invalid.`)
  })
}

function readRequiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required.`)
  }
  if (value.length > maxLength) {
    throw new HttpError(400, `${field} is too large.`)
  }
  return value
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string.`)
  }
  if (value.length > maxLength) {
    throw new HttpError(400, `${field} must be ${maxLength} characters or fewer.`)
  }
  return value.trim() || undefined
}

function readOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HttpError(400, `${field} must be a positive number.`)
  }
  return value
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
