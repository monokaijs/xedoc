import { useEffect } from "react"

export const DEFAULT_DOCUMENT_TITLE = "xedoc"

export function formatDocumentTitle(title?: string | null) {
  const normalizedTitle = title?.replace(/\s+/g, " ").trim()
  return normalizedTitle
    ? `${normalizedTitle} - ${DEFAULT_DOCUMENT_TITLE}`
    : DEFAULT_DOCUMENT_TITLE
}

export function useDocumentTitle(title?: string | null) {
  const documentTitle = formatDocumentTitle(title)

  useEffect(() => {
    if (typeof document === "undefined") {
      return
    }

    document.title = documentTitle

    return () => {
      document.title = DEFAULT_DOCUMENT_TITLE
    }
  }, [documentTitle])
}
