export type NormalizedCommandOutput = {
  chunkId?: string
  durationMs?: number
  exitCode?: number
  originalTokenCount?: number
  output: string
  wrapperDetected: boolean
}

const CHUNK_ID_RE = /^Chunk ID:\s*(.+)$/i
const EXIT_CODE_RE = /^Process exited with code\s+(-?\d+|unknown|null)$/i
const ORIGINAL_TOKEN_COUNT_RE = /^Original token count:\s*(\d+)$/i
const OUTPUT_RE = /^Output:\s*(.*)$/i
const WALL_TIME_RE = /^Wall time:\s*([0-9]+(?:\.[0-9]+)?)\s*seconds?$/i

export function normalizeCommandOutput(
  value?: string | null,
): NormalizedCommandOutput {
  const output = value ?? ""
  const wrapper = parseCodexCommandOutputWrapper(output)
  if (!wrapper) {
    return { output, wrapperDetected: false }
  }
  return wrapper
}

function parseCodexCommandOutputWrapper(
  value: string,
): NormalizedCommandOutput | null {
  const normalized = value.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  const firstContentIndex = lines.findIndex((line) => line.trim())
  if (firstContentIndex < 0) {
    return null
  }

  const firstLine = lines[firstContentIndex].trim()
  const chunkMatch = CHUNK_ID_RE.exec(firstLine)
  if (!chunkMatch) {
    return null
  }

  const outputLineIndex = lines.findIndex(
    (line, index) => index > firstContentIndex && OUTPUT_RE.test(line.trim()),
  )
  if (outputLineIndex < 0) {
    return null
  }

  const headerLines = lines
    .slice(firstContentIndex, outputLineIndex)
    .map((line) => line.trim())
  const hasRuntimeMetadata = headerLines.some((line) => WALL_TIME_RE.test(line))
  const hasExitMetadata = headerLines.some((line) => EXIT_CODE_RE.test(line))
  if (!hasRuntimeMetadata && !hasExitMetadata) {
    return null
  }

  const outputLine = lines[outputLineIndex].trim()
  const inlineOutput = OUTPUT_RE.exec(outputLine)?.[1] ?? ""
  const outputLines = lines.slice(outputLineIndex + 1)
  const cleanOutput = (inlineOutput ? [inlineOutput, ...outputLines] : outputLines)
    .join("\n")
    .replace(/\n$/, "")

  return {
    chunkId: chunkMatch[1].trim(),
    durationMs: parseDurationMs(headerLines),
    exitCode: parseExitCode(headerLines),
    originalTokenCount: parseOriginalTokenCount(headerLines),
    output: cleanOutput,
    wrapperDetected: true,
  }
}

function parseDurationMs(lines: string[]): number | undefined {
  for (const line of lines) {
    const match = WALL_TIME_RE.exec(line)
    if (!match) {
      continue
    }
    const seconds = Number(match[1])
    if (Number.isFinite(seconds)) {
      return Math.round(seconds * 1000)
    }
  }
  return undefined
}

function parseExitCode(lines: string[]): number | undefined {
  for (const line of lines) {
    const match = EXIT_CODE_RE.exec(line)
    if (!match) {
      continue
    }
    const code = Number(match[1])
    if (Number.isFinite(code)) {
      return code
    }
  }
  return undefined
}

function parseOriginalTokenCount(lines: string[]): number | undefined {
  for (const line of lines) {
    const match = ORIGINAL_TOKEN_COUNT_RE.exec(line)
    if (!match) {
      continue
    }
    const count = Number(match[1])
    if (Number.isFinite(count)) {
      return count
    }
  }
  return undefined
}
