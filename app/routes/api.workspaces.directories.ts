import { verifyRequest } from "@/server/auth.server"
import {
  handleRouteError,
  jsonResponse,
  readJsonBody,
  readStringField,
  requireMethod,
} from "@/server/http.server"
import { createDirectory, listDirectory } from "@/server/workspaces.server"
import type { CreateWorkspaceDirectoryRequest } from "@/types"

export async function loader({ request }: { request: Request }) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    const url = new URL(request.url)
    return jsonResponse(await listDirectory(url.searchParams.get("path") ?? undefined))
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request }: { request: Request }) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const body = await readJsonBody<CreateWorkspaceDirectoryRequest>(request)
    const dto: CreateWorkspaceDirectoryRequest = {
      parentPath: readStringField(body.parentPath, "parentPath", {
        required: true,
        maxLength: 4096,
      }),
      name: readStringField(body.name, "name", {
        required: true,
        maxLength: 255,
      }),
    }
    return jsonResponse(await createDirectory(dto.parentPath, dto.name), {
      status: 201,
    })
  } catch (error) {
    return handleRouteError(error)
  }
}
