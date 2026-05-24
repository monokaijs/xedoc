import { createContext } from "react"

export type FileViewerTarget = {
  line?: number | null
  path: string
}

export const FileViewerContext = createContext<
  ((target: FileViewerTarget) => void) | null
>(null)
