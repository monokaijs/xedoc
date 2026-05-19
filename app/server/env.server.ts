import { asJsonObject } from "./json.server"

export function normalizeEnvironment(
  value: unknown,
): Record<string, string> | null {
  const object = asJsonObject(value)
  if (!object) {
    return null
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, String(entry)]),
  )
}
