import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { HttpError } from "@/server/http.server"
import type {
  ServerUpdateResponse,
  ServerUpdateStatusResponse,
} from "@/types"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(process.cwd())
const packageJsonPath = join(packageRoot, "package.json")
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org"
export const SERVER_RESTART_EXIT_CODE = 42

let updateInProgress = false
let restartScheduled = false

export async function readServerUpdateStatus(): Promise<ServerUpdateStatusResponse> {
  const packageInfo = await readPackageInfo()
  const registryUrl = normalizedRegistryUrl()
  const checkedAt = new Date().toISOString()

  try {
    const latestVersion = await readLatestPackageVersion(
      packageInfo.name,
      registryUrl,
    )
    return {
      packageName: packageInfo.name,
      currentVersion: packageInfo.version,
      latestVersion,
      updateAvailable: versionIsNewer(latestVersion, packageInfo.version),
      checkedAt,
      registryUrl,
      canUpdate: true,
      installCommand: formatInstallCommand(packageInfo.name),
      restartRequired: true,
      message: null,
      lastError: null,
    }
  } catch (caught) {
    return {
      packageName: packageInfo.name,
      currentVersion: packageInfo.version,
      latestVersion: null,
      updateAvailable: false,
      checkedAt,
      registryUrl,
      canUpdate: true,
      installCommand: formatInstallCommand(packageInfo.name),
      restartRequired: true,
      message: "Could not check npm for updates.",
      lastError: readError(caught),
    }
  }
}

export async function updateServerPackage({
  force = false,
}: {
  force?: boolean
}): Promise<ServerUpdateResponse> {
  if (updateInProgress) {
    throw new HttpError(409, "An update is already in progress.")
  }

  updateInProgress = true
  try {
    const status = await readServerUpdateStatus()
    if (!force && !status.updateAvailable) {
      return {
        ...status,
        restartScheduled: false,
        message: status.lastError
          ? "Update check failed. Use force update to reinstall from npm."
          : "Already on the latest version.",
      }
    }

    await installLatestPackage(status.packageName)
    scheduleRestart()

    return {
      ...status,
      updateAvailable: false,
      restartScheduled: true,
      message: `Updated ${status.packageName}. Restarting xedoc...`,
      lastError: null,
    }
  } finally {
    updateInProgress = false
  }
}

async function readPackageInfo(): Promise<{
  name: string
  version: string
}> {
  const raw = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    name?: unknown
    version?: unknown
  }
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    throw new HttpError(500, "Package name is missing.")
  }
  if (typeof raw.version !== "string" || !raw.version.trim()) {
    throw new HttpError(500, "Package version is missing.")
  }
  return {
    name: raw.name,
    version: raw.version,
  }
}

async function readLatestPackageVersion(
  packageName: string,
  registryUrl: string,
): Promise<string> {
  const response = await fetch(
    `${registryUrl}/${encodeNpmPackageName(packageName)}/latest`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  )
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}.`)
  }
  const data = (await response.json()) as { version?: unknown }
  if (typeof data.version !== "string" || !data.version.trim()) {
    throw new Error("npm registry response did not include a version.")
  }
  return data.version
}

async function installLatestPackage(packageName: string): Promise<void> {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm"
  const args = [
    "install",
    "--global",
    "--no-audit",
    "--no-fund",
    `${packageName}@latest`,
  ]
  try {
    await execFileAsync(executable, args, {
      cwd: packageRoot,
      env: process.env,
      maxBuffer: 1024 * 1024 * 4,
    })
  } catch (caught) {
    throw new Error(`Update failed: ${readExecError(caught)}`)
  }
}

function scheduleRestart(): void {
  if (restartScheduled) {
    return
  }
  restartScheduled = true
  const timeout = setTimeout(() => {
    process.exit(SERVER_RESTART_EXIT_CODE)
  }, 500)
  timeout.unref()
}

function normalizedRegistryUrl(): string {
  return (process.env.XEDOC_NPM_REGISTRY ?? DEFAULT_REGISTRY_URL).replace(
    /\/+$/u,
    "",
  )
}

function encodeNpmPackageName(packageName: string): string {
  return packageName.startsWith("@")
    ? `@${encodeURIComponent(packageName.slice(1)).replace("%2F", "%2f")}`
    : encodeURIComponent(packageName)
}

function formatInstallCommand(packageName: string): string {
  return `npm install -g ${packageName}@latest`
}

function versionIsNewer(next: string, current: string): boolean {
  const comparison = compareSemver(next, current)
  return comparison === null ? next !== current : comparison > 0
}

function compareSemver(left: string, right: string): number | null {
  const leftParts = parseSemver(left)
  const rightParts = parseSemver(right)
  if (!leftParts || !rightParts) {
    return null
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1
    }
  }
  return 0
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value.trim())
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function readExecError(value: unknown): string {
  if (value && typeof value === "object") {
    const error = value as {
      message?: unknown
      stderr?: unknown
      stdout?: unknown
    }
    const output = [error.stderr, error.stdout]
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .find(Boolean)
    if (output) {
      return output.length > 1000 ? `${output.slice(0, 1000)}...` : output
    }
    if (typeof error.message === "string") {
      return error.message
    }
  }
  return readError(value)
}

function readError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
