import type { JsonObject } from "@/types"

export function asJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  return value as JsonObject
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
