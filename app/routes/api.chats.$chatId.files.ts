import { verifyRequest } from "@/server/auth.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readNumberQuery,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import { readChatWorkspaceFile } from "@/server/workspace-files.server"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    const url = new URL(request.url)
    const path = url.searchParams.get("path")?.trim()
    if (!path) {
      throw new HttpError(400, "path is required.")
    }
    return jsonResponse(
      await readChatWorkspaceFile(
        requireParam(params, "chatId"),
        path,
        readNumberQuery(url, "line", 0) || null,
      ),
    )
  } catch (error) {
    return handleRouteError(error)
  }
}
