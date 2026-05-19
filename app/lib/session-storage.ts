import type { ClientSession } from "@/types"

export type WebSession = ClientSession

const keys = {
  serverUrl: "xedoc.web.server-url",
  token: "xedoc.web.token",
}

export function loadStoredSession(): WebSession | null {
  const storage = getStorage()
  if (!storage) {
    return null
  }

  const serverUrl = readStoredValue(storage, "serverUrl")
  const token = readStoredValue(storage, "token")

  if (!serverUrl || !token) {
    return null
  }

  return {
    serverUrl,
    token,
  }
}

export function saveStoredSession(session: WebSession): void {
  const storage = getStorage()
  if (!storage) {
    return
  }

  writeStoredValue(storage, "serverUrl", session.serverUrl)
  writeStoredValue(storage, "token", session.token)
}

export function clearStoredSession(): void {
  const storage = getStorage()
  if (!storage) {
    return
  }

  removeStoredValue(storage, "serverUrl")
  removeStoredValue(storage, "token")
}

function getStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage
}

function readStoredValue(storage: Storage, key: keyof typeof keys): string | null {
  return storage.getItem(keys[key])
}

function writeStoredValue(
  storage: Storage,
  key: keyof typeof keys,
  value: string,
): void {
  storage.setItem(keys[key], value)
}

function removeStoredValue(storage: Storage, key: keyof typeof keys): void {
  storage.removeItem(keys[key])
}
