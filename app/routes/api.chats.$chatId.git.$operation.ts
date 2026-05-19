import { verifyRequest } from "@/server/auth.server"
import {
  performGitAction,
  readGitBranches,
  readGitDiff,
  readGitStatus,
} from "@/server/git.server"
import {
  handleRouteError,
  HttpError,
  jsonResponse,
  readJsonBody,
  readStringField,
  requireMethod,
  requireParam,
} from "@/server/http.server"
import type { GitActionRequest, GitActionType } from "@/types"

type RouteArgs = {
  request: Request
  params: Record<string, string | undefined>
}

export async function loader({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["GET"])
    await verifyRequest(request)
    const chatId = requireParam(params, "chatId")
    const operation = requireParam(params, "operation")
    const url = new URL(request.url)
    if (operation === "status") {
      return jsonResponse(await readGitStatus(chatId))
    }
    if (operation === "branches") {
      return jsonResponse(await readGitBranches(chatId))
    }
    if (operation === "diff") {
      return jsonResponse(await readGitDiff(chatId, url.searchParams.get("path")))
    }
    throw new HttpError(404, "Git operation not found.")
  } catch (error) {
    return handleRouteError(error)
  }
}

export async function action({ request, params }: RouteArgs) {
  try {
    requireMethod(request, ["POST"])
    await verifyRequest(request)
    const operation = requireParam(params, "operation")
    if (operation !== "action") {
      throw new HttpError(404, "Git operation not found.")
    }
    const body = await readJsonBody<GitActionRequest>(request)
    const dto: GitActionRequest = {
      action: readGitAction(body.action),
      branch: readStringField(body.branch, "branch", { maxLength: 240 }),
      message: readStringField(body.message, "message", { maxLength: 5000 }),
    }
    return jsonResponse(await performGitAction(requireParam(params, "chatId"), dto))
  } catch (error) {
    return handleRouteError(error)
  }
}

function readGitAction(value: unknown): GitActionType {
  if (
    value === "checkout" ||
    value === "createBranch" ||
    value === "commit" ||
    value === "pull" ||
    value === "push"
  ) {
    return value
  }
  throw new HttpError(400, "action is invalid.")
}
