import type { ChatResponse, ChatStatus } from "@/types"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  ChevronDown,
  Folder,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { archiveChat, updateChat } from "@/lib/api"
import type { WebSession } from "@/lib/session-storage"
import { cn } from "@/lib/utils"
import {
  chatFolderKey,
  chatFolderName,
  chatFolderPath,
  formatChatListDate,
  isConcreteFolderPath,
  readError,
} from "@/screens/chat-runtime-utils"

const CHAT_GROUP_VISIBLE_LIMIT = 4

type ChatSidebarItem = {
  chat: ChatResponse
  dateLabel: string
  folderKey: string
  folderName: string
  folderPath: string
  order: number
}

type ChatSidebarGroup = {
  items: ChatSidebarItem[]
  key: string
  name: string
  order: number
  path: string
}

export function ChatSidebar({
  chats,
  session,
}: {
  chats: ChatResponse[]
  session: WebSession
}) {
  const navigate = useNavigate()
  const { chatId } = useParams()
  const queryClient = useQueryClient()
  const [renameTarget, setRenameTarget] = useState<ChatResponse | null>(null)
  const [renameTitle, setRenameTitle] = useState("")
  const [archiveTarget, setArchiveTarget] = useState<ChatResponse | null>(null)
  const [collapsedFolderKeys, setCollapsedFolderKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const [expandedFolderKeys, setExpandedFolderKeys] = useState<Set<string>>(
    () => new Set(),
  )

  const orderedChats = useMemo(
    () => [...chats].sort(compareChatsByActivity),
    [chats],
  )
  const chatItems = useMemo(
    () =>
      orderedChats.map((chat, index) => ({
        chat,
        dateLabel: formatChatListDate(chat.lastSentAt),
        folderKey: chatFolderKey(chat.workingDirectory),
        folderName: chatFolderName(chat.workingDirectory),
        folderPath: chatFolderPath(chat.workingDirectory),
        order: index,
      })),
    [orderedChats],
  )
  const chatGroups = useMemo<ChatSidebarGroup[]>(() => {
    const groups = new Map<string, ChatSidebarGroup>()
    for (const item of chatItems) {
      const group = groups.get(item.folderKey)
      if (group) {
        group.items.push(item)
        continue
      }
      groups.set(item.folderKey, {
        items: [item],
        key: item.folderKey,
        name: item.folderName,
        order: item.order,
        path: item.folderPath,
      })
    }
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        items: group.items.sort(
          (a, b) =>
            a.order - b.order ||
            a.chat.title.localeCompare(b.chat.title, undefined, {
              sensitivity: "base",
            }),
        ),
      }))
      .sort(
        (a, b) =>
          a.order - b.order ||
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      )
  }, [chatItems])

  const renameMutation = useMutation({
    mutationFn: () => {
      if (!renameTarget) {
        throw new Error("Select a chat to rename.")
      }
      return updateChat(session, renameTarget.id, {
        title: renameTitle.trim() || "Untitled chat",
      })
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: () => {
      setRenameTarget(null)
      setRenameTitle("")
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (target: ChatResponse) => archiveChat(session, target.id),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (_chat, target) => {
      setArchiveTarget(null)
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      if (chatId === target.id) {
        navigate("/")
      }
    },
  })

  return (
    <>
      <SidebarMenu className="gap-1">
        {chatGroups.length ? (
          chatGroups.map((group) => {
            const groupCollapsed = collapsedFolderKeys.has(group.key)
            const groupExpanded = expandedFolderKeys.has(group.key)
            const visibleItems = visibleChatItems(
              group.items,
              chatId,
              groupExpanded,
            )
            const hiddenCount = group.items.length - visibleItems.length
            const canStartInFolder = isConcreteFolderPath(group.path)

            return (
              <SidebarMenuItem key={group.key}>
                <div className="flex min-w-0 items-center gap-1 pr-1">
                  <button
                    className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/75 outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent"
                    title={group.path}
                    type="button"
                    onClick={() =>
                      setCollapsedFolderKeys((current) => {
                        const next = new Set(current)
                        if (next.has(group.key)) {
                          next.delete(group.key)
                        } else {
                          next.add(group.key)
                        }
                        return next
                      })
                    }
                  >
                    <Folder className="size-3.5 shrink-0 text-cyan-500" />
                    <span className="min-w-0 flex-1 truncate">
                      {group.name}
                    </span>
                    <span className="shrink-0 text-[0.68rem] font-normal text-muted-foreground">
                      {group.items.length}
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground transition-transform",
                        groupCollapsed && "-rotate-90",
                      )}
                    />
                  </button>
                  {canStartInFolder ? (
                    <Button
                      aria-label={`New chat in ${group.name}`}
                      className="size-7 shrink-0"
                      size="icon-sm"
                      title={`New chat in ${group.path}`}
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        navigate("/", {
                          state: { workingDirectory: group.path },
                        })
                      }
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                {groupCollapsed ? null : (
                  <SidebarMenu className="gap-0.5 pl-4">
                    {visibleItems.map(({ chat, dateLabel, folderName }) => (
                      <SidebarMenuItem
                        className="flex min-w-0 items-center"
                        key={chat.id}
                      >
                        <SidebarMenuButton
                          className="h-7 min-w-0 flex-1 px-2 pr-2! text-xs"
                          isActive={chat.id === chatId}
                          size="sm"
                          tooltip={`${chat.title} · ${chatStatusLabel(chat.status)} · ${dateLabel} · ${folderName}`}
                          onClick={() => navigate(`/chat/${chat.id}`)}
                        >
                          <ChatStatusIcon status={chat.status} />
                          <span className="min-w-0 flex-1 truncate">
                            {chat.title}
                          </span>
                        </SidebarMenuButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                aria-label="Chat actions"
                                className="pointer-events-none h-7 w-0 shrink-0 overflow-hidden opacity-0 transition-[width,opacity] group-hover/menu-item:pointer-events-auto group-hover/menu-item:ml-1 group-hover/menu-item:w-7 group-hover/menu-item:opacity-100 group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:ml-1 group-focus-within/menu-item:w-7 group-focus-within/menu-item:opacity-100 aria-expanded:pointer-events-auto aria-expanded:ml-1 aria-expanded:w-7 aria-expanded:opacity-100"
                                size="icon-sm"
                                variant="ghost"
                              />
                            }
                          >
                            <MoreHorizontal className="size-4" />
                            <span className="sr-only">Chat actions</span>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem
                              onClick={() => {
                                setRenameTarget(chat)
                                setRenameTitle(chat.title)
                              }}
                            >
                              <Pencil />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setArchiveTarget(chat)}
                            >
                              <Archive />
                              Archive
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    ))}
                    {hiddenCount > 0 ? (
                      <li>
                        <button
                          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent"
                          type="button"
                          onClick={() =>
                            setExpandedFolderKeys((current) =>
                              new Set(current).add(group.key),
                            )
                          }
                        >
                          <ChevronDown className="size-3.5 shrink-0" />
                          <span className="min-w-0 truncate">
                            Show {hiddenCount} more
                          </span>
                        </button>
                      </li>
                    ) : groupExpanded &&
                      group.items.length > CHAT_GROUP_VISIBLE_LIMIT ? (
                      <li>
                        <button
                          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent"
                          type="button"
                          onClick={() =>
                            setExpandedFolderKeys((current) => {
                              const next = new Set(current)
                              next.delete(group.key)
                              return next
                            })
                          }
                        >
                          <ChevronDown className="size-3.5 shrink-0 rotate-180" />
                          <span className="min-w-0 truncate">Show less</span>
                        </button>
                      </li>
                    ) : null}
                  </SidebarMenu>
                )}
              </SidebarMenuItem>
            )
          })
        ) : (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            No chats yet.
          </div>
        )}
      </SidebarMenu>

      <Dialog
        open={!!renameTarget}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setRenameTarget(null)
            setRenameTitle("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>
              Choose a short title for the sidebar.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                renameMutation.mutate()
              }
            }}
          />
          <DialogFooter>
            <Button
              disabled={renameMutation.isPending}
              onClick={() => renameMutation.mutate()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!archiveTarget}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setArchiveTarget(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive chat?</DialogTitle>
            <DialogDescription>
              This removes {archiveTarget?.title ?? "the chat"} from the active
              chat list. Message history stays on the server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={archiveMutation.isPending || !archiveTarget}
              variant="destructive"
              onClick={() => {
                if (archiveTarget) {
                  archiveMutation.mutate(archiveTarget)
                }
              }}
            >
              <Archive />
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ChatStatusIcon({ status }: { status: ChatStatus }) {
  if (status === "RUNNING") {
    return (
      <Loader2
        aria-label="Running"
        className="size-3.5 shrink-0 animate-spin text-cyan-500"
      />
    )
  }
  return (
    <MessageSquare
      aria-label={chatStatusLabel(status)}
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  )
}

function compareChatsByActivity(left: ChatResponse, right: ChatResponse) {
  return (
    new Date(right.lastSentAt).getTime() - new Date(left.lastSentAt).getTime() ||
    new Date(right.lastActivityAt).getTime() -
      new Date(left.lastActivityAt).getTime() ||
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  )
}

function visibleChatItems(
  items: ChatSidebarItem[],
  activeChatId: string | undefined,
  expanded: boolean,
): ChatSidebarItem[] {
  if (expanded || items.length <= CHAT_GROUP_VISIBLE_LIMIT) {
    return items
  }

  const visible = items.slice(0, CHAT_GROUP_VISIBLE_LIMIT)
  if (!activeChatId || visible.some((item) => item.chat.id === activeChatId)) {
    return visible
  }

  const activeItem = items.find((item) => item.chat.id === activeChatId)
  if (!activeItem) {
    return visible
  }

  return [...visible.slice(0, CHAT_GROUP_VISIBLE_LIMIT - 1), activeItem]
}

function chatStatusLabel(status: ChatStatus): string {
  switch (status) {
    case "RUNNING":
      return "running"
    case "ARCHIVED":
      return "archived"
    case "IDLE":
      return "idle"
  }
}
