import type { ChatMessageAttachment } from "@/types"
import { useContext } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"
import {
  FileViewerContext,
  type FileViewerTarget,
} from "@/components/timeline/file-viewer-context"
import "highlight.js/styles/github.css"

export function AssistantMarkdown({ text }: { text: string }) {
  const openFile = useContext(FileViewerContext)
  return (
    <div className="min-w-0 max-w-full overflow-hidden break-words px-1 text-sm leading-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, className, href, ...props }) => {
            const target = parseLocalFileReference(href ?? "")
            return target && openFile ? (
              <button
                className={cn(
                  "inline min-w-0 break-words text-left underline underline-offset-2",
                  className,
                )}
                type="button"
                onClick={() => openFile(target)}
              >
                {children}
              </button>
            ) : (
              <a
                className={cn("underline underline-offset-2", className)}
                href={href}
                rel="noreferrer"
                target="_blank"
                {...props}
              >
                {children}
              </a>
            )
          },
          blockquote: ({ className, ...props }) => (
            <blockquote
              className={cn(
                "my-3 border-l-2 border-border pl-3 text-muted-foreground",
                className,
              )}
              {...props}
            />
          ),
          code: ({ className, children, ...props }) => {
            const languageClass =
              typeof className === "string" && className.includes("language-")
            return (
              <code
                className={cn(
                  languageClass
                    ? "block bg-transparent p-0 font-mono text-xs leading-5"
                    : "whitespace-pre-wrap break-words rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] font-medium",
                  className,
                )}
                {...props}
              >
                {children}
              </code>
            )
          },
          del: ({ className, ...props }) => (
            <del
              className={cn("text-muted-foreground line-through", className)}
              {...props}
            />
          ),
          em: ({ className, ...props }) => (
            <em className={cn("italic", className)} {...props} />
          ),
          h1: ({ className, ...props }) => (
            <h1
              className={cn(
                "mb-2 mt-4 text-xl font-semibold tracking-normal",
                className,
              )}
              {...props}
            />
          ),
          h2: ({ className, ...props }) => (
            <h2
              className={cn(
                "mb-2 mt-4 text-lg font-semibold tracking-normal",
                className,
              )}
              {...props}
            />
          ),
          h3: ({ className, ...props }) => (
            <h3
              className={cn(
                "mb-2 mt-3 text-base font-semibold tracking-normal",
                className,
              )}
              {...props}
            />
          ),
          h4: ({ className, ...props }) => (
            <h4
              className={cn(
                "mb-1.5 mt-3 text-sm font-semibold tracking-normal",
                className,
              )}
              {...props}
            />
          ),
          h5: ({ className, ...props }) => (
            <h5
              className={cn(
                "mb-1.5 mt-3 text-sm font-semibold tracking-normal",
                className,
              )}
              {...props}
            />
          ),
          h6: ({ className, ...props }) => (
            <h6
              className={cn(
                "mb-1 mt-3 text-xs font-semibold uppercase tracking-normal text-muted-foreground",
                className,
              )}
              {...props}
            />
          ),
          hr: ({ className, ...props }) => (
            <hr className={cn("my-4 border-border", className)} {...props} />
          ),
          img: ({ className, ...props }) => (
            <img
              className={cn(
                "my-3 max-w-full rounded-md border border-border",
                className,
              )}
              loading="lazy"
              {...props}
            />
          ),
          input: ({ className, type, ...props }) =>
            type === "checkbox" ? (
              <input
                className={cn(
                  "mr-2 size-3.5 align-middle accent-primary disabled:opacity-70",
                  className,
                )}
                type={type}
                {...props}
              />
            ) : (
              <input className={className} type={type} {...props} />
            ),
          li: ({ className, ...props }) => (
            <li className={cn("pl-1 [&>p]:my-0", className)} {...props} />
          ),
          ol: ({ className, ...props }) => (
            <ol
              className={cn(
                "my-2 ml-5 list-decimal space-y-1 marker:text-muted-foreground",
                className,
              )}
              {...props}
            />
          ),
          p: ({ className, ...props }) => (
            <p
              className={cn("my-2 first:mt-0 last:mb-0", className)}
              {...props}
            />
          ),
          pre: ({ className, ...props }) => (
            <pre
              className={cn(
                "my-3 min-w-0 max-w-full overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-5 [&_code]:block [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:font-normal",
                className,
              )}
              {...props}
            />
          ),
          strong: ({ className, ...props }) => (
            <strong className={cn("font-semibold", className)} {...props} />
          ),
          table: ({ className, ...props }) => (
            <div className="my-3 max-w-full overflow-x-auto">
              <table
                className={cn(
                  "w-full border-collapse text-left text-sm [&_tbody_tr:nth-child(odd)]:bg-muted/30 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted/60 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold",
                  className,
                )}
                {...props}
              />
            </div>
          ),
          ul: ({ className, ...props }) => (
            <ul
              className={cn(
                "my-2 ml-5 list-disc space-y-1 marker:text-muted-foreground",
                className,
              )}
              {...props}
            />
          ),
        }}
      >
        {imageTagsToMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
}

export type ImageTaggedTextPart =
  | { text: string; type: "text" }
  | { src: string; type: "image" }

export type UserImagePreviewItem = {
  id: string
  name: string
  src: string
}

export function textFromImageTaggedParts(parts: ImageTaggedTextPart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim()
}

export function userImagePreviewItems(
  parts: ImageTaggedTextPart[],
  attachments: ChatMessageAttachment[],
): UserImagePreviewItem[] {
  const items: UserImagePreviewItem[] = []
  const seen = new Set<string>()
  const pushItem = (item: UserImagePreviewItem) => {
    if (seen.has(item.src)) {
      return
    }
    seen.add(item.src)
    items.push(item)
  }

  parts.forEach((part, index) => {
    if (part.type === "image") {
      pushItem({
        id: `inline-image:${index}:${part.src}`,
        name: "Attached image",
        src: part.src,
      })
    }
  })

  attachments.forEach((attachment) => {
    if (attachment.kind === "image") {
      pushItem({
        id: attachment.id,
        name: attachment.name,
        src: attachment.url,
      })
    }
  })

  return items
}

function imageTagsToMarkdown(text: string): string {
  return splitImageTags(text)
    .map((part) =>
      part.type === "image"
        ? `\n\n![](${encodeURI(part.src).replace(/\)/g, "%29")})\n\n`
        : part.text,
    )
    .join("")
}

export function splitImageTags(text: string): ImageTaggedTextPart[] {
  const parts: ImageTaggedTextPart[] = []
  const pattern = /<image>\s*([\s\S]*?)\s*<\/image>/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), type: "text" })
    }

    const src = normalizeImageTagSource(match[1])
    parts.push(src ? { src, type: "image" } : { text: match[0], type: "text" })
    const trailingCloseTag = /^\s*<\/image>/i.exec(
      text.slice(pattern.lastIndex),
    )
    if (src && trailingCloseTag) {
      pattern.lastIndex += trailingCloseTag[0].length
    }
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), type: "text" })
  }
  return parts.length ? parts : [{ text, type: "text" }]
}

function normalizeImageTagSource(value: string): string | null {
  let src = value.trim()
  while (/^<image>/i.test(src)) {
    src = src.replace(/^<image>\s*/i, "").trim()
  }
  while (/<\/image>$/i.test(src)) {
    src = src.replace(/\s*<\/image>$/i, "").trim()
  }
  if (
    !src ||
    /[\u0000-\u001f\u007f]/.test(src) ||
    src.includes("\n") ||
    src.includes("\r")
  ) {
    return null
  }
  if (
    src.startsWith("/") ||
    src.startsWith("data:image/") ||
    /^https?:\/\//i.test(src)
  ) {
    return src
  }
  return null
}

function parseLocalFileReference(href: string): FileViewerTarget | null {
  const trimmed = safeDecodeURIComponent(href.trim()).replace(/^<|>$/g, "")
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith("file://"))
  ) {
    return null
  }
  const withoutFileScheme = trimmed.startsWith("file://")
    ? trimmed.slice("file://".length)
    : trimmed
  const hashLine = /^(.*)#L(\d+)(?:-L?\d+)?$/i.exec(withoutFileScheme)
  if (hashLine) {
    return { line: Number(hashLine[2]), path: hashLine[1] }
  }
  const colonLine = /^(.+):(\d+)(?::\d+)?$/.exec(withoutFileScheme)
  if (colonLine && !/^[A-Za-z]:\\/.test(withoutFileScheme)) {
    return { line: Number(colonLine[2]), path: colonLine[1] }
  }
  return { path: withoutFileScheme }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
