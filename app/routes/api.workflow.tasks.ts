import { verifyRequest } from "@/server/auth.server"
import {
  createWorkflowTask,
  listWorkflowTasks,
} from "@/server/workflow-tasks.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  readStringField,
  requireMethod,
} from "@/server/http.server"
import type {
  CreateWorkflowTaskRequest,
  WorkflowTaskStatus,
} from "@/types"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    const url = new URL(request.url)
    return jsonResponse(
      await listWorkflowTasks({
        projectPath: url.searchParams.get("projectPath"),
        status: url.searchParams.get("status"),
      }),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<CreateWorkflowTaskRequest>(request)
    const dto: CreateWorkflowTaskRequest = {
      projectPath: readStringField(body.projectPath, "projectPath", {
        required: true,
        maxLength: 4096,
      }),
      title: readStringField(body.title, "title", {
        required: true,
        maxLength: 180,
      }),
      description: readOptionalTextField(body.description, "description", 8000),
      status: readStringField(body.status, "status", {
        maxLength: 40,
      }) as WorkflowTaskStatus | undefined,
    }
    return jsonResponse(await createWorkflowTask(dto), { status: 201 })
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
