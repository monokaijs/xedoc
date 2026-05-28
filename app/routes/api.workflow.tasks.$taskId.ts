import { verifyRequest } from "@/server/auth.server"
import {
  deleteWorkflowTask,
  getWorkflowTask,
  updateWorkflowTask,
} from "@/server/workflow-tasks.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  readStringField,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type {
  UpdateWorkflowTaskRequest,
  WorkflowTaskStatus,
} from "@/types"

type RouteArgs = {
  params: {
    taskId?: string
  }
  request: Request
}

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    return jsonResponse(await getWorkflowTask(requireParam(params, "taskId")))
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request, params }: RouteArgs) {
  try {
    await verifyRequest(request)
    const taskId = requireParam(params, "taskId")
    if (request.method === "PATCH") {
      const body = await readJsonBody<UpdateWorkflowTaskRequest>(request)
      const dto: UpdateWorkflowTaskRequest = {
        projectPath: readStringField(body.projectPath, "projectPath", {
          maxLength: 4096,
        }),
        title: readStringField(body.title, "title", { maxLength: 180 }),
        description: readOptionalTextField(body.description, "description", 8000),
        status: readStringField(body.status, "status", {
          maxLength: 40,
        }) as WorkflowTaskStatus | undefined,
      }
      return jsonResponse(await updateWorkflowTask(taskId, dto))
    }
    if (request.method === "DELETE") {
      return jsonResponse(await deleteWorkflowTask(taskId))
    }
    requireMethod(request, ["PATCH", "DELETE"])
  } catch (error) {
    return handleRouteError(error)
  }
}

function readOptionalTextField(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string.`)
  }
  if (value.length > maxLength) {
    throw new HttpError(400, `${field} must be ${maxLength} characters or fewer.`)
  }
  return value.trim()
}
