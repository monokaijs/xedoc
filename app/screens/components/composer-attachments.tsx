import type { ChatAttachmentInput } from "@/types"
import { File as FileIcon, X } from "lucide-react"
import type { RefObject } from "react"
import { Button } from "@/components/ui/button"
import { displayNameForPath } from "@/screens/chat-runtime-utils"

export type ComposerAttachment =
  | {
      dataUrl: string
      id: string
      kind: "image"
      mimeType: string
      name: string
      size: number
    }
  | {
      id: string
      kind: "file"
      name: string
      path: string
      size?: number
    }

export function composerAttachmentsToRequest(
  attachments: ComposerAttachment[],
): ChatAttachmentInput[] {
  return attachments.map((attachment) =>
    attachment.kind === "image"
      ? {
          dataUrl: attachment.dataUrl,
          kind: "image",
          mimeType: attachment.mimeType,
          name: attachment.name,
          size: attachment.size,
        }
      : {
          kind: "file",
          name: attachment.name,
          path: attachment.path,
          size: attachment.size,
        },
  )
}

export async function imageAttachmentsFromFiles(
  files: FileList | File[],
): Promise<ComposerAttachment[]> {
  const imageFiles = Array.from(files).filter((file) =>
    file.type.startsWith("image/"),
  )
  return Promise.all(
    imageFiles.map(async (file) => ({
      dataUrl: await readFileAsDataUrl(file),
      id: crypto.randomUUID(),
      kind: "image" as const,
      mimeType: file.type || "image/png",
      name: file.name || "image",
      size: file.size,
    })),
  )
}

export function imageFilesFromClipboard(data: DataTransfer): File[] {
  const files = Array.from(data.files).filter((file) =>
    file.type.startsWith("image/"),
  )
  if (files.length) {
    return files
  }
  return Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file)
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(reader.error ?? new Error("Unable to read image."))
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.readAsDataURL(file)
  })
}

export function fileAttachmentFromPath(path: string): ComposerAttachment {
  const normalized = path.trim()
  return {
    id: crypto.randomUUID(),
    kind: "file",
    name: displayNameForPath(normalized),
    path: normalized,
  }
}

export function AttachmentTray({
  attachments,
  imageInputRef,
  onAttachImages,
  onRemove,
}: {
  attachments: ComposerAttachment[]
  imageInputRef: RefObject<HTMLInputElement | null>
  onAttachImages: (files: FileList | File[] | null) => void
  onRemove: (id: string) => void
}) {
  return (
    <>
      <input
        accept="image/*"
        className="hidden"
        multiple
        ref={imageInputRef}
        type="file"
        onChange={(event) => {
          onAttachImages(event.currentTarget.files)
          event.currentTarget.value = ""
        }}
      />
      {attachments.length ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          {attachments.map((attachment) => (
            <div
              className="flex min-w-0 max-w-full items-center gap-2 rounded-md border bg-muted/35 px-2 py-1 text-xs"
              key={attachment.id}
            >
              {attachment.kind === "image" ? (
                <img
                  alt=""
                  className="size-7 rounded border object-cover"
                  src={attachment.dataUrl}
                />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 max-w-48 truncate">
                {attachment.kind === "file" ? attachment.path : attachment.name}
              </span>
              <Button
                aria-label="Remove attachment"
                className="size-5"
                size="icon-xs"
                type="button"
                variant="ghost"
                onClick={() => onRemove(attachment.id)}
              >
                <X className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
