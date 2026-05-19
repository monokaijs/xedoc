import type {
  AccountResponse,
  AccountRuntimeSettingsRequest,
  ChatAttachmentInput,
  ChatResponse,
  ChatEventPayloads,
  ChatEventType,
  ContextWindowUsagePayload,
  CodexCollaborationMode,
  CodexModelOption,
  CodexPermissionMode,
  CodexRateLimitSnapshot,
  CodexRateLimitWindow,
  CodexRateLimitsResponse,
  CodexReasoningEffort,
  CodexServiceTier,
  ExecuteChatRequest,
  MessagePageResponse,
  GitBranchesResponse,
  GitStatusResponse,
} from "@/types"
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  Archive,
  ArrowUp,
  Brain,
  Check,
  Clock,
  Cpu,
  Filter,
  File as FileIcon,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  ListChecks,
  Loader2,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Paperclip,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Settings,
  SquarePen,
  Square,
  Terminal as TerminalIcon,
  Upload,
  Download,
  Image as ImageIcon,
  RefreshCw,
  X,
  Zap,
  UserRound,
} from "lucide-react"
import type { RefObject } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Navigate,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router"
import { toast } from "sonner"
import {
  ServerSettingsDialog,
  type ServerSettingsTab,
} from "@/components/server-settings-dialog"
import { TerminalDock } from "@/components/terminal-dock"
import { ThemeSwitcher } from "@/components/theme-switcher"
import {
  ChatComposerContextPanel,
  ChatTimeline,
  findStickyChatContext,
} from "@/components/timeline/chat-timeline"
import type {
  FileChangePromptAction,
  ProposedPlanAction,
  ProposedPlanRevisionAction,
} from "@/components/timeline/chat-timeline"
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { WorkspacePickerDialog } from "@/components/workspace-picker-dialog"
import {
  appendMessage,
  archiveChat,
  createChat,
  executeChatMessage,
  getChatContext,
  getChat,
  getChatMessages,
  getGitBranches,
  getGitDiff,
  getGitStatus,
  interruptChatRun,
  listCodexModels,
  listAccounts,
  listChats,
  readCodexRateLimits,
  runGitAction,
  updateAccountRuntimeSettings,
  updateChat,
} from "@/lib/api"
import { applyChatEvent, highestSequence } from "@/lib/chat-events"
import { useDocumentTitle } from "@/lib/document-title"
import { cn } from "@/lib/utils"
import type { WebSession } from "@/lib/session-storage"
import { connectChatEventSocket } from "@/lib/socket"
import {
  connectTerminalSocket,
  type TerminalSocket,
} from "@/lib/terminal-socket"
import { useSession } from "@/providers/session-provider"

const IMPLEMENT_LATEST_PLAN_PROMPT =
  "Implement the latest approved plan from the most recent proposed plan in this thread."

function reviseLatestPlanPrompt(feedback: string) {
  return [
    "Revise the latest proposed plan from this thread using the following requested changes.",
    "Do not implement yet. Return an updated proposed plan.",
    "",
    feedback,
  ].join("\n")
}

interface ShellContext {
  accounts: AccountResponse[]
  chats: ChatResponse[]
  accountRateLimitSnapshots: Record<string, CodexRateLimitSnapshot>
  accountUsageSummaries: Record<string, string>
  activeProjectPath: string
  connectedAccounts: AccountResponse[]
  lastOpenedChat: ChatResponse | null
  openAccountManagement: () => void
  openWorkspacePicker: (options: {
    initialPath?: string | null
    mode?: "directory" | "file"
    onSelect: (path: string) => void
  }) => void
  session: WebSession
  setActiveProjectPath: (path: string) => void
  setTerminalOpen: (open: boolean) => void
  terminalOpen: boolean
  terminalSocket: TerminalSocket | null
  terminalSocketConnected: boolean
}

export function AppShell() {
  const { clearSession, loading, refreshSession, session } = useSession()
  const { chatId } = useParams()
  const terminalConnection = useTerminalConnection(session)
  const [activeProjectPath, setActiveProjectPath] = useState("")
  const [lastOpenedChatId, setLastOpenedChatId] = useState<string | null>(null)
  const [accountCreateFocusKey, setAccountCreateFocusKey] = useState(0)
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [serverSettingsTab, setServerSettingsTab] =
    useState<ServerSettingsTab>("server")
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [workspacePicker, setWorkspacePicker] = useState<{
    initialPath?: string | null
    mode?: "directory" | "file"
    onSelect: (path: string) => void
  } | null>(null)
  const navigate = useNavigate()

  const openAccountManagement = useCallback(
    (options?: { focusCreate?: boolean }) => {
      if (options?.focusCreate) {
        setAccountCreateFocusKey((current) => current + 1)
      } else {
        setAccountCreateFocusKey(0)
      }
      setServerSettingsTab("accounts")
      setServerSettingsOpen(true)
    },
    [],
  )

  const changeServerSettingsTab = useCallback((tab: ServerSettingsTab) => {
    if (tab === "accounts") {
      setAccountCreateFocusKey(0)
    }
    setServerSettingsTab(tab)
  }, [])

  const openServerSettings = useCallback((tab: ServerSettingsTab = "server") => {
    setServerSettingsTab(tab)
    setServerSettingsOpen(true)
  }, [])

  const accountsQuery = useQuery({
    enabled: !!session,
    queryKey: ["accounts"],
    queryFn: () => listAccounts(session!),
  })

  const chatsQuery = useQuery({
    enabled: !!session,
    queryKey: ["chats"],
    queryFn: () => listChats(session!),
  })

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data])
  const chats = useMemo(() => chatsQuery.data ?? [], [chatsQuery.data])
  const activeChatTitle = useMemo(() => {
    if (!chatId) {
      return null
    }
    return chats.find((chat) => chat.id === chatId)?.title ?? null
  }, [chatId, chats])
  useEffect(() => {
    if (chatId) {
      setLastOpenedChatId(chatId)
    }
  }, [chatId])
  const lastOpenedChat = useMemo(() => {
    if (chatId) {
      const activeChat = chats.find((chat) => chat.id === chatId)
      if (activeChat) {
        return activeChat
      }
    }
    if (lastOpenedChatId) {
      const openedChat = chats.find((chat) => chat.id === lastOpenedChatId)
      if (openedChat) {
        return openedChat
      }
    }
    return chats[0] ?? null
  }, [chatId, chats, lastOpenedChatId])
  const connectedAccounts = useMemo(
    () => accounts.filter((account) => account.status === "CONNECTED"),
    [accounts],
  )
  useDocumentTitle(activeChatTitle)
  const accountRateLimitQueries = useQueries({
    queries: connectedAccounts.map((account) => ({
      enabled: !!session,
      queryKey: ["rate-limits", account.id],
      queryFn: () => readCodexRateLimits(session!, account.id),
      refetchInterval: 60_000,
      retry: false,
      staleTime: 30_000,
    })),
  })
  const accountRateLimitSnapshots = useMemo(() => {
    return Object.fromEntries(
      connectedAccounts
        .map((account, index) => {
          const snapshot = selectRateLimitSnapshot(accountRateLimitQueries[index]?.data)
          return snapshot ? [account.id, snapshot] : null
        })
        .filter((entry): entry is [string, CodexRateLimitSnapshot] => !!entry),
    )
  }, [accountRateLimitQueries, connectedAccounts])
  const accountUsageSummaries = useMemo(() => {
    return Object.fromEntries(
      connectedAccounts
        .map((account) => {
          const snapshot = accountRateLimitSnapshots[account.id]
          return snapshot ? [account.id, usageCapacityLabel(snapshot)] : null
        })
        .filter((entry): entry is [string, string] => !!entry),
    )
  }, [accountRateLimitSnapshots, connectedAccounts])

  useEffect(() => {
    if (!activeProjectPath.trim()) {
      setTerminalOpen(false)
    }
  }, [activeProjectPath])

  if (loading) {
    return <FullScreenLoader />
  }

  if (!session) {
    return <Navigate replace to="/connect" />
  }

  const shellContext: ShellContext = {
    accounts,
    accountRateLimitSnapshots,
    accountUsageSummaries,
    activeProjectPath,
    chats,
    connectedAccounts,
    lastOpenedChat,
    openAccountManagement,
    openWorkspacePicker: setWorkspacePicker,
    session,
    setActiveProjectPath,
    setTerminalOpen,
    terminalOpen,
    terminalSocket: terminalConnection.socket,
    terminalSocketConnected: terminalConnection.connected,
  }

  return (
    <>
      <SidebarProvider>
        <Sidebar className="border-r" collapsible="icon">
          <SidebarHeader>
            <Button
              className="w-full justify-start"
              variant="ghost"
              onClick={() => navigate("/")}
            >
              <SquarePen />
              <span className="group-data-[collapsible=icon]:hidden">
                New chat
              </span>
            </Button>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Chats</SidebarGroupLabel>
              <SidebarGroupContent>
                <ChatSidebar chats={chats} session={session} />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <Button
              className="justify-start"
              variant="ghost"
              onClick={() => openServerSettings()}
            >
              <Settings />
              <span className="group-data-[collapsible=icon]:hidden">
                Settings
              </span>
            </Button>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="h-svh min-w-0 overflow-hidden">
          <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-3">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger variant="ghost">
                <Menu />
              </SidebarTrigger>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <HeaderTerminalButton
                active={terminalOpen}
                disabled={!activeProjectPath.trim()}
                onToggle={() => setTerminalOpen(!terminalOpen)}
              />
              <HeaderCreateMenu
                onAddAccount={() => openAccountManagement({ focusCreate: true })}
                onNewChat={() => navigate("/")}
              />
              <ThemeSwitcher />
            </div>
          </header>

          {accountsQuery.error || chatsQuery.error ? (
            <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {accountsQuery.error?.message ??
                chatsQuery.error?.message ??
                "Unable to load workspace data."}
            </div>
          ) : null}

          <Outlet context={shellContext} />
        </SidebarInset>
      </SidebarProvider>

      <ServerSettingsDialog
        accounts={accounts}
        activeTab={serverSettingsTab}
        clearSession={clearSession}
        createFocusKey={accountCreateFocusKey}
        open={serverSettingsOpen}
        refreshSession={refreshSession}
        session={session}
        onTabChange={changeServerSettingsTab}
        onOpenChange={setServerSettingsOpen}
      />
      {workspacePicker ? (
        <WorkspacePickerDialog
          initialPath={workspacePicker.initialPath}
          mode={workspacePicker.mode}
          open={!!workspacePicker}
          session={session}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setWorkspacePicker(null)
            }
          }}
          onSelect={workspacePicker.onSelect}
        />
      ) : null}
    </>
  )
}

function useTerminalConnection(session: WebSession | null) {
  const [connected, setConnected] = useState(false)
  const [count, setCount] = useState(0)
  const [socket, setSocket] = useState<TerminalSocket | null>(null)

  useEffect(() => {
    if (!session) {
      setConnected(false)
      setCount(0)
      setSocket(null)
      return
    }

    const connection = connectTerminalSocket(session, {
      onClose: () => setConnected(false),
      onCount: (payload) => setCount(Math.max(0, payload.count)),
      onError: () => setConnected(false),
      onOpen: () => setConnected(true),
    })
    setSocket(connection.socket)
    return () => {
      connection.disconnect()
      setConnected(false)
      setSocket(null)
    }
  }, [session?.serverUrl, session?.token])

  return { connected, count, socket }
}

function HeaderTerminalButton({
  active,
  disabled,
  onToggle,
}: {
  active: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <Button
      aria-label="Terminal"
      aria-pressed={active}
      disabled={disabled}
      size="icon"
      title={disabled ? "Choose a working directory" : "Terminal"}
      type="button"
      variant={active ? "secondary" : "ghost"}
      onClick={onToggle}
    >
      <TerminalIcon />
    </Button>
  )
}

function HeaderCreateMenu({
  onAddAccount,
  onNewChat,
}: {
  onAddAccount: () => void
  onNewChat: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon" variant="outline" />}>
        <Plus className="size-4" />
        <span className="sr-only">Create</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={onNewChat}>
          <SquarePen />
          New chat
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAddAccount}>
          <UserRound />
          Add account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChatSidebar({
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
  const [searchQuery, setSearchQuery] = useState("")
  const [folderFilter, setFolderFilter] = useState<string | null>(null)

  const chatItems = useMemo(
    () =>
      chats.map((chat) => ({
        chat,
        dateLabel: formatChatListDate(chat.lastActivityAt),
        folderName: chatFolderName(chat.workingDirectory),
      })),
    [chats],
  )
  const folderOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of chatItems) {
      counts.set(item.folderName, (counts.get(item.folderName) ?? 0) + 1)
    }
    return Array.from(counts, ([name, count]) => ({ count, name })).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    )
  }, [chatItems])
  const filteredChatItems = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
    return chatItems.filter(({ chat, folderName }) => {
      if (folderFilter && folderName !== folderFilter) {
        return false
      }
      if (!normalizedSearch) {
        return true
      }
      return [chat.title, folderName, chat.workingDirectory ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedSearch)
    })
  }, [chatItems, folderFilter, searchQuery])
  const hasChatFilters = !!searchQuery.trim() || !!folderFilter

  useEffect(() => {
    if (
      folderFilter &&
      !folderOptions.some((option) => option.name === folderFilter)
    ) {
      setFolderFilter(null)
    }
  }, [folderFilter, folderOptions])

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
      <div className="mb-2 flex items-center gap-1 px-1 group-data-[collapsible=icon]:hidden">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
          <Input
            aria-label="Search chats"
            className="h-8 bg-background pl-7"
            placeholder="Search chats"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                aria-label="Filter chats by folder"
                className={cn("relative", folderFilter && "text-foreground")}
                size="icon"
                variant={folderFilter ? "secondary" : "outline"}
              />
            }
          >
            <Filter className="size-4" />
            {folderFilter ? (
              <span
                aria-hidden="true"
                className="absolute right-1.5 top-1.5 size-2 rounded-full bg-red-500 ring-2 ring-background"
              />
            ) : null}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64" side="bottom">
            <PopoverHeader>
              <PopoverTitle>Folder</PopoverTitle>
              <PopoverDescription>Show chats from one folder.</PopoverDescription>
            </PopoverHeader>
            <div className="max-h-72 overflow-y-auto">
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted",
                  !folderFilter && "bg-muted",
                )}
                type="button"
                onClick={() => setFolderFilter(null)}
              >
                <span className="min-w-0 flex-1 truncate">All folders</span>
                <span className="text-xs text-muted-foreground">{chats.length}</span>
                {!folderFilter ? <Check className="size-4" /> : null}
              </button>
              {folderOptions.map((option) => (
                <button
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted",
                    folderFilter === option.name && "bg-muted",
                  )}
                  key={option.name}
                  type="button"
                  onClick={() => setFolderFilter(option.name)}
                >
                  <Folder className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {option.count}
                  </span>
                  {folderFilter === option.name ? (
                    <Check className="size-4" />
                  ) : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <SidebarMenu>
        {filteredChatItems.length ? (
          filteredChatItems.map(({ chat, dateLabel, folderName }) => (
            <SidebarMenuItem key={chat.id}>
              <SidebarMenuButton
                className="h-14 min-w-0 items-start py-1.5 pr-2! group-has-data-[sidebar=menu-action]/menu-item:pr-2! group-data-[collapsible=icon]:items-center! group-data-[collapsible=icon]:justify-center!"
                isActive={chat.id === chatId}
                size="lg"
                tooltip={`${chat.title} · ${dateLabel} · ${folderName}`}
                onClick={() => navigate(`/chat/${chat.id}`)}
              >
                <MessageSquare className="mt-0.5 group-data-[collapsible=icon]:mt-0!" />
                <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden!">
                  <span className="block truncate leading-5">{chat.title}</span>
                  <span className="flex min-w-0 items-center gap-2 text-[11px] leading-4 font-normal text-muted-foreground">
                    <span className="flex min-w-0 items-center gap-1">
                      <Clock className="!size-3 shrink-0" />
                      <span className="truncate">{dateLabel}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1">
                      <Folder className="!size-3 shrink-0" />
                      <span className="truncate">{folderName}</span>
                    </span>
                  </span>
                </span>
              </SidebarMenuButton>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuAction
                      aria-label="Chat actions"
                      className="right-2 top-3 size-7 pointer-events-none opacity-0 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100 aria-expanded:pointer-events-auto aria-expanded:opacity-100 [&>svg]:size-5"
                      showOnHover
                    />
                  }
                >
                  <MoreHorizontal />
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
                  <DropdownMenuItem onClick={() => setArchiveTarget(chat)}>
                    <Archive />
                    Archive
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          ))
        ) : (
          <div className="px-2 py-3 text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
            {chats.length ? "No matching chats." : "No chats yet."}
            {hasChatFilters ? (
              <Button
                className="mt-2 h-7 px-2 text-xs"
                size="sm"
                variant="outline"
                onClick={() => {
                  setFolderFilter(null)
                  setSearchQuery("")
                }}
              >
                Clear filters
              </Button>
            ) : null}
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

type ComposerAttachment =
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

function composerAttachmentsToRequest(
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

async function imageAttachmentsFromFiles(
  files: FileList | File[],
): Promise<ComposerAttachment[]> {
  const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"))
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

function imageFilesFromClipboard(data: DataTransfer): File[] {
  const files = Array.from(data.files).filter((file) => file.type.startsWith("image/"))
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file)
  const seen = new Set<string>()
  return [...files, ...itemFiles].filter((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read image."))
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.readAsDataURL(file)
  })
}

function fileAttachmentFromPath(path: string): ComposerAttachment {
  const normalized = path.trim()
  return {
    id: crypto.randomUUID(),
    kind: "file",
    name: displayNameForPath(normalized),
    path: normalized,
  }
}

function AttachmentTray({
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

export function NewChatPane() {
  const {
    accountRateLimitSnapshots,
    accountUsageSummaries,
    connectedAccounts,
    lastOpenedChat,
    openAccountManagement,
    openWorkspacePicker,
    session,
    setActiveProjectPath,
    setTerminalOpen,
    terminalOpen,
    terminalSocket,
    terminalSocketConnected,
  } = useShellContext()
  const [content, setContent] = useState("")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [collaborationMode, setCollaborationMode] =
    useState<CodexCollaborationMode>("default")
  const [model, setModel] = useState<string | null>(null)
  const [autoRotateAccount, setAutoRotateAccount] = useState(
    lastOpenedChat?.autoRotateAccount ?? false,
  )
  const [newChatAccountId, setNewChatAccountId] = useState<string | null>(
    lastOpenedChat?.accountId ?? null,
  )
  const [permissionMode, setPermissionMode] =
    useState<CodexPermissionMode>("default")
  const [reasoningEffort, setReasoningEffort] =
    useState<CodexReasoningEffort | null>(null)
  const [runtimeAccountId, setRuntimeAccountId] = useState<string | null>(null)
  const [serviceTier, setServiceTier] = useState<CodexServiceTier | null>(null)
  const [workingDirectory, setWorkingDirectory] = useState(
    lastOpenedChat?.workingDirectory?.trim() ?? "",
  )
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const seededLastOpenedChatIdRef = useRef<string | null>(
    lastOpenedChat?.id ?? null,
  )

  useEffect(() => {
    setActiveProjectPath(workingDirectory.trim())
    return () => setActiveProjectPath("")
  }, [setActiveProjectPath, workingDirectory])

  useEffect(() => {
    if (!lastOpenedChat || seededLastOpenedChatIdRef.current === lastOpenedChat.id) {
      return
    }

    seededLastOpenedChatIdRef.current = lastOpenedChat.id
    const nextWorkingDirectory = lastOpenedChat.workingDirectory?.trim() ?? ""
    if (nextWorkingDirectory) {
      setWorkingDirectory((current) =>
        current.trim() ? current : nextWorkingDirectory,
      )
    }
    const nextAccountId = lastOpenedChat.accountId
    if (nextAccountId) {
      setNewChatAccountId((current) => current ?? nextAccountId)
    }
  }, [lastOpenedChat])

  const bestAvailableAccount = useMemo(
    () => selectBestAvailableAccount(connectedAccounts, accountRateLimitSnapshots),
    [accountRateLimitSnapshots, connectedAccounts],
  )
  const manuallySelectedAccount = connectedAccounts.find(
    (account) => account.id === newChatAccountId,
  )
  const selectedConnectedAccount =
    (autoRotateAccount &&
    manuallySelectedAccount &&
    accountAvailabilityScore(accountRateLimitSnapshots[manuallySelectedAccount.id]) < 0
      ? undefined
      : manuallySelectedAccount) ??
    bestAvailableAccount ??
    connectedAccounts[0]

  useEffect(() => {
    if (!selectedConnectedAccount?.id) {
      setRuntimeAccountId(null)
      setModel(null)
      setPermissionMode("default")
      setReasoningEffort(null)
      setServiceTier(null)
      return
    }
    setRuntimeAccountId(selectedConnectedAccount.id)
    setModel(selectedConnectedAccount.defaultModel ?? null)
    setPermissionMode(selectedConnectedAccount.defaultPermissionMode ?? "default")
    setReasoningEffort(selectedConnectedAccount.defaultReasoningEffort ?? null)
    setServiceTier(selectedConnectedAccount.defaultServiceTier ?? null)
  }, [
    selectedConnectedAccount?.defaultModel,
    selectedConnectedAccount?.defaultPermissionMode,
    selectedConnectedAccount?.defaultReasoningEffort,
    selectedConnectedAccount?.defaultServiceTier,
    selectedConnectedAccount?.id,
  ])

  const modelsQuery = useQuery({
    enabled: !!selectedConnectedAccount?.id,
    queryKey: ["models", selectedConnectedAccount?.id],
    queryFn: () => listCodexModels(session, selectedConnectedAccount!.id),
    staleTime: 5 * 60 * 1000,
  })
  const rateLimitsQuery = useQuery({
    enabled: !!selectedConnectedAccount?.id,
    queryKey: ["rate-limits", selectedConnectedAccount?.id],
    queryFn: () => readCodexRateLimits(session, selectedConnectedAccount!.id),
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  })
  const modelOptions = modelsQuery.data?.data ?? []
  const runtimeSelectionsApply = runtimeAccountId === selectedConnectedAccount?.id
  const effectiveModel = runtimeSelectionsApply ? model : null
  const effectiveReasoningEffort = runtimeSelectionsApply ? reasoningEffort : null
  const effectiveServiceTier = runtimeSelectionsApply ? serviceTier : null
  const selectedModel = selectedModelOption(modelOptions, effectiveModel)
  const reasoningOptions =
    selectedModel?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort) ??
    []
  const activeReasoningEffort =
    effectiveReasoningEffort ?? selectedModel?.defaultReasoningEffort ?? null
  const serviceTierOptions = selectedModel?.additionalSpeedTiers ?? []
  const rateLimitSnapshot = selectRateLimitSnapshot(rateLimitsQuery.data)

  const updateAccountDefaultsMutation = useMutation({
    mutationFn: ({
      accountId,
      settings,
    }: {
      accountId: string
      settings: AccountRuntimeSettingsRequest
    }) => updateAccountRuntimeSettings(session, accountId, settings),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (account) => {
      queryClient.setQueryData<AccountResponse[] | undefined>(
        ["accounts"],
        (accounts) => upsertAccount(accounts, account),
      )
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedConnectedAccount) {
        throw new Error("Connect an account before starting a chat.")
      }
      if (!workingDirectory.trim()) {
        throw new Error("Choose a working directory before starting a chat.")
      }
      const chat = await createChat(session, {
        accountId: selectedConnectedAccount.id,
        autoRotateAccount,
        collaborationMode,
        model: effectiveModel,
        permissionMode,
        reasoningEffort: effectiveReasoningEffort,
        serviceTier: effectiveServiceTier,
        workingDirectory: workingDirectory.trim(),
      })
      const response = await executeChatMessage(session, chat.id, {
        attachments: composerAttachmentsToRequest(attachments),
        content: content.trim(),
      })
      return { chat, response }
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: ({ chat, response }) => {
      setContent("")
      setAttachments([])
      setAutoRotateAccount(false)
      setCollaborationMode("default")
      setPermissionMode(selectedConnectedAccount?.defaultPermissionMode ?? "default")
      setWorkingDirectory("")
      queryClient.setQueryData<MessagePageResponse>(
        ["messages", chat.id],
        appendMessages(undefined, executeResponseMessages(response)),
      )
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      navigate(`/chat/${chat.id}`)
    },
  })

  const attachImages = useCallback((files: FileList | File[] | null) => {
    if (!files?.length) {
      return
    }
    void imageAttachmentsFromFiles(files)
      .then((nextAttachments) => {
        setAttachments((current) => [...current, ...nextAttachments])
      })
      .catch((caught) => toast.error(readError(caught)))
  }, [])

  const attachWorkspaceFile = useCallback(() => {
    openWorkspacePicker({
      initialPath: workingDirectory,
      mode: "file",
      onSelect: (path) => {
        setAttachments((current) => [...current, fileAttachmentFromPath(path)])
      },
    })
  }, [openWorkspacePicker, workingDirectory])

  const terminalProjectPath = workingDirectory.trim()
  const showTerminalDock = terminalOpen && !!terminalProjectPath

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
      <div
        className={cn(
          "mx-auto flex w-full flex-1 flex-col gap-6 px-4",
          showTerminalDock
            ? "max-w-5xl justify-start py-4 sm:justify-center sm:py-8"
            : "max-w-3xl justify-center py-8",
        )}
      >
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-normal">
            What should Codex work on?
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Select an account and workspace, then send the first message.
          </p>
        </div>

        {!connectedAccounts.length ? (
          <div className="rounded-md border bg-muted/35 p-4 text-sm">
            <div className="font-medium">No connected account</div>
            <div className="mt-1 text-muted-foreground">
              Create and authenticate a Codex account before starting a chat.
            </div>
            <Button className="mt-3" size="sm" onClick={openAccountManagement}>
              <UserRound />
              Manage Accounts
            </Button>
          </div>
        ) : null}

        {showTerminalDock ? (
          <TerminalDock
            onClosePanel={() => setTerminalOpen(false)}
            projectPath={terminalProjectPath}
            socket={terminalSocket}
            socketConnected={terminalSocketConnected}
          />
        ) : (
        <div className="grid gap-3 rounded-xl border bg-background p-3 shadow-sm">
          <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/25 px-2 py-1.5">
            <Input
              autoCapitalize="none"
              className="h-8 min-w-0 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0"
              placeholder="Working directory"
              spellCheck={false}
              value={workingDirectory}
              onChange={(event) => setWorkingDirectory(event.target.value)}
            />
            <Button
              className="size-8 shrink-0"
              size="icon"
              title="Choose directory"
              type="button"
              variant="ghost"
              onClick={() =>
                openWorkspacePicker({
                  initialPath: workingDirectory,
                  onSelect: setWorkingDirectory,
                })
              }
            >
              <FolderOpen />
              <span className="sr-only">Choose directory</span>
            </Button>
          </div>
          <Textarea
            className="min-h-32 resize-none border-0 px-1 shadow-none focus-visible:ring-0"
            placeholder="Message Codex"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                if (
                  !createMutation.isPending &&
                  canSend(content, workingDirectory, selectedConnectedAccount, attachments)
                ) {
                  createMutation.mutate()
                }
              }
            }}
            onPaste={(event) => {
              const files = imageFilesFromClipboard(event.clipboardData)
              if (files.length) {
                attachImages(files)
              }
            }}
          />
          <AttachmentTray
            attachments={attachments}
            imageInputRef={imageInputRef}
            onAttachImages={attachImages}
            onRemove={(id) =>
              setAttachments((current) =>
                current.filter((attachment) => attachment.id !== id),
              )
            }
          />
          <div className="flex items-center justify-between gap-1 sm:gap-3">
            <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden sm:flex-wrap sm:gap-0">
              <PlanModeSelector
                attachmentDisabled={createMutation.isPending}
                disabled={!selectedConnectedAccount}
                mode={collaborationMode}
                onAttachFile={attachWorkspaceFile}
                onAttachImage={() => imageInputRef.current?.click()}
                onSelectMode={setCollaborationMode}
              />
              <CodexAccountSelector
                account={selectedConnectedAccount}
                autoRotate={autoRotateAccount}
                autoRotateDisabled={createMutation.isPending}
                connectedAccounts={connectedAccounts}
                disabled={!connectedAccounts.length}
                selectedAccountId={selectedConnectedAccount?.id ?? ""}
                usageSummaries={accountUsageSummaries}
                onAutoRotateChange={setAutoRotateAccount}
                onSelect={(accountId) => {
                  setNewChatAccountId(accountId)
                }}
              />
              <ChatRuntimeSelector
                activeReasoningEffort={activeReasoningEffort}
                disabled={!selectedConnectedAccount}
                modelOptions={modelOptions}
                modelValue={effectiveModel ?? ""}
                pending={modelsQuery.isFetching}
                reasoningOptions={reasoningOptions}
                reasoningValue={effectiveReasoningEffort ?? ""}
                selectedModel={selectedModel}
                serviceTierOptions={serviceTierOptions}
                serviceTierValue={effectiveServiceTier ?? ""}
                onSelectModel={(nextModel) => {
                  const accountId = selectedConnectedAccount?.id ?? null
                  setRuntimeAccountId(accountId)
                  setModel(nextModel || null)
                  setReasoningEffort(null)
                  setServiceTier(null)
                  if (accountId) {
                    updateAccountDefaultsMutation.mutate({
                      accountId,
                      settings: {
                        defaultModel: nextModel || null,
                        defaultReasoningEffort: null,
                        defaultServiceTier: null,
                      },
                    })
                  }
                }}
                onSelectReasoning={(nextEffort) => {
                  const accountId = selectedConnectedAccount?.id ?? null
                  const reasoningEffort = nextEffort
                    ? (nextEffort as CodexReasoningEffort)
                    : null
                  setRuntimeAccountId(accountId)
                  setReasoningEffort(reasoningEffort)
                  if (accountId) {
                    updateAccountDefaultsMutation.mutate({
                      accountId,
                      settings: {
                        defaultModel: effectiveModel,
                        defaultReasoningEffort: reasoningEffort,
                        defaultServiceTier: effectiveServiceTier,
                      },
                    })
                  }
                }}
                onSelectServiceTier={(nextTier) => {
                  const accountId = selectedConnectedAccount?.id ?? null
                  const serviceTier = nextTier ? (nextTier as CodexServiceTier) : null
                  setRuntimeAccountId(accountId)
                  setServiceTier(serviceTier)
                  if (accountId) {
                    updateAccountDefaultsMutation.mutate({
                      accountId,
                      settings: {
                        defaultModel: effectiveModel,
                        defaultReasoningEffort: effectiveReasoningEffort,
                        defaultServiceTier: serviceTier,
                      },
                    })
                  }
                }}
              />
              <PermissionModeSelector
                disabled={!selectedConnectedAccount}
                mode={permissionMode}
                onSelectMode={(nextPermissionMode) => {
                  setPermissionMode(nextPermissionMode)
                  if (selectedConnectedAccount?.id) {
                    updateAccountDefaultsMutation.mutate({
                      accountId: selectedConnectedAccount.id,
                      settings: { defaultPermissionMode: nextPermissionMode },
                    })
                  }
                }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              <UsageCapacityPill
                pending={rateLimitsQuery.isFetching}
                snapshot={rateLimitSnapshot}
              />
              <ComposerActionButton
                loading={createMutation.isPending}
                sendDisabled={
                  !canSend(content, workingDirectory, selectedConnectedAccount, attachments)
                }
                onSend={() => createMutation.mutate()}
              />
            </div>
          </div>
        </div>
        )}
      </div>
    </main>
  )
}

export function ChatDetailPane() {
  const { chatId } = useParams()
  const {
    accounts,
    accountRateLimitSnapshots,
    accountUsageSummaries,
    connectedAccounts,
    openWorkspacePicker,
    session,
    setActiveProjectPath,
    setTerminalOpen,
    terminalOpen,
    terminalSocket,
    terminalSocketConnected,
  } =
    useShellContext()
  const [content, setContent] = useState("")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [streamState, setStreamState] = useState<"OFFLINE" | "ONLINE">(
    "OFFLINE",
  )
  const [contextWindowUsage, setContextWindowUsage] =
    useState<ContextWindowUsagePayload | null>(null)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const stickToBottomRef = useRef(true)
  const queryClient = useQueryClient()
  const chatQueryKey = useMemo(() => ["chat", chatId] as const, [chatId])
  const messagesQueryKey = useMemo(
    () => ["messages", chatId] as const,
    [chatId],
  )

  useEffect(() => {
    setContextWindowUsage(null)
    setAttachments([])
  }, [chatId])

  const chatQuery = useQuery({
    enabled: !!chatId,
    queryKey: chatQueryKey,
    queryFn: () => getChat(session, chatId!),
  })

  const messagesQuery = useQuery({
    enabled: !!chatId,
    queryKey: messagesQueryKey,
    queryFn: () => getChatMessages(session, chatId!, 0),
  })
  const contextQuery = useQuery({
    enabled: !!chatId && !contextWindowUsage,
    queryKey: ["chat-context", chatId],
    queryFn: () => getChatContext(session, chatId!),
    retry: false,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (contextQuery.data?.usage && !contextWindowUsage) {
      setContextWindowUsage(contextQuery.data.usage)
    }
  }, [contextQuery.data?.usage, contextWindowUsage])
  const messages = useMemo(
    () => messagesQuery.data?.data ?? [],
    [messagesQuery.data],
  )
  const stickyChatContext = useMemo(
    () => findStickyChatContext(messages),
    [messages],
  )
  const hiddenTimelineMessageIds = useMemo(
    () =>
      stickyChatContext.pendingRequest
        ? [stickyChatContext.pendingRequest.id]
        : [],
    [stickyChatContext.pendingRequest],
  )
  const scrollSignature = useMemo(
    () =>
      messages
        .map(
          (message) =>
            `${message.id}:${message.sequence}:${message.status}:${message.content.length}`,
        )
        .join("|"),
    [messages],
  )

  const loadedChat = chatQuery.data
  const loadedAccount = accounts.find((entry) => entry.id === loadedChat?.accountId)

  useEffect(() => {
    setActiveProjectPath(loadedChat?.workingDirectory?.trim() ?? "")
    return () => setActiveProjectPath("")
  }, [loadedChat?.workingDirectory, setActiveProjectPath])

  const isNearScrollBottom = useCallback((element: HTMLDivElement) => {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 96
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = scrollViewportRef.current
    if (!element) {
      return
    }
    element.scrollTo({ behavior, top: element.scrollHeight })
  }, [])

  const modelsQuery = useQuery({
    enabled: !!loadedAccount?.id && loadedAccount.status === "CONNECTED",
    queryKey: ["models", loadedAccount?.id],
    queryFn: () => listCodexModels(session, loadedAccount!.id),
    staleTime: 5 * 60 * 1000,
  })
  const rateLimitsQuery = useQuery({
    enabled: !!loadedAccount?.id && loadedAccount.status === "CONNECTED",
    queryKey: ["rate-limits", loadedAccount?.id],
    queryFn: () => readCodexRateLimits(session, loadedAccount!.id),
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  })

  const updateAccountMutation = useMutation({
    mutationFn: (input: { accountId: string; notify?: boolean }) =>
      updateChat(session, chatId!, { accountId: input.accountId }),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (chat, input) => {
      queryClient.setQueryData(chatQueryKey, chat)
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      if (input.notify !== false) {
        toast.success("Chat account updated.")
      }
    },
  })

  const updateRuntimeMutation = useMutation({
    mutationFn: (patch: {
      autoRotateAccount?: boolean
      collaborationMode?: CodexCollaborationMode | null
      model?: string | null
      permissionMode?: CodexPermissionMode | null
      reasoningEffort?: CodexReasoningEffort | null
      serviceTier?: CodexServiceTier | null
    }) => updateChat(session, chatId!, patch),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (chat) => {
      queryClient.setQueryData(chatQueryKey, chat)
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const updateAccountDefaultsMutation = useMutation({
    mutationFn: ({
      accountId,
      settings,
    }: {
      accountId: string
      settings: AccountRuntimeSettingsRequest
    }) => updateAccountRuntimeSettings(session, accountId, settings),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (account) => {
      queryClient.setQueryData<AccountResponse[] | undefined>(
        ["accounts"],
        (accounts) => upsertAccount(accounts, account),
      )
    },
  })

  const sendMutation = useMutation({
    mutationFn: (input?: {
      attachments?: ChatAttachmentInput[]
      clearComposer?: boolean
      collaborationMode?: CodexCollaborationMode | null
      content?: string
      delivery?: ExecuteChatRequest["delivery"]
      metadata?: Record<string, unknown>
    }) =>
      executeChatMessage(session, chatId!, {
        attachments: input?.attachments,
        collaborationMode: input?.collaborationMode,
        content: (input?.content ?? content).trim(),
        delivery: input?.delivery,
        metadata: input?.metadata,
      }),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (response, input) => {
      stickToBottomRef.current = true
      if (input?.clearComposer ?? true) {
        setContent("")
        setAttachments([])
      }
      queryClient.setQueryData<MessagePageResponse | undefined>(
        messagesQueryKey,
        (page) => appendMessages(page, executeResponseMessages(response)),
      )
      void queryClient.invalidateQueries({ queryKey: chatQueryKey })
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const interruptMutation = useMutation({
    mutationFn: () => interruptChatRun(session, chatId!),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: () => {
      toast.message("Stop requested.")
    },
  })

  const bestAvailableAccount = useMemo(
    () => selectBestAvailableAccount(connectedAccounts, accountRateLimitSnapshots),
    [accountRateLimitSnapshots, connectedAccounts],
  )
  const autoRotateTargetAccount = useMemo(
    () =>
      autoRotateTargetAccountForChat(
        loadedChat,
        loadedAccount,
        bestAvailableAccount,
        accountRateLimitSnapshots,
      ),
    [accountRateLimitSnapshots, bestAvailableAccount, loadedAccount, loadedChat],
  )
  const autoRotateTargetAccountId = autoRotateTargetAccount?.id

  useEffect(() => {
    if (
      !autoRotateTargetAccountId ||
      updateAccountMutation.isPending ||
      sendMutation.isPending
    ) {
      return
    }
    updateAccountMutation.mutate({
      accountId: autoRotateTargetAccountId,
      notify: false,
    })
  }, [
    autoRotateTargetAccountId,
    sendMutation.isPending,
    updateAccountMutation.isPending,
  ])

  const attachImages = useCallback((files: FileList | File[] | null) => {
    if (!files?.length) {
      return
    }
    void imageAttachmentsFromFiles(files)
      .then((nextAttachments) => {
        setAttachments((current) => [...current, ...nextAttachments])
      })
      .catch((caught) => toast.error(readError(caught)))
  }, [])

  const attachWorkspaceFile = useCallback(() => {
    openWorkspacePicker({
      initialPath: chatQuery.data?.workingDirectory,
      mode: "file",
      onSelect: (path) => {
        setAttachments((current) => [...current, fileAttachmentFromPath(path)])
      },
    })
  }, [chatQuery.data?.workingDirectory, openWorkspacePicker])

  const implementPlan = useCallback(
    (action: ProposedPlanAction) => {
      sendMutation.mutate({
        clearComposer: false,
        collaborationMode: "default",
        content: IMPLEMENT_LATEST_PLAN_PROMPT,
        metadata: {
          action: "implementPlan",
          planMessageId: action.message.id,
          source: "proposedPlan",
        },
      })
    },
    [sendMutation],
  )

  const revisePlan = useCallback(
    (action: ProposedPlanRevisionAction) => {
      sendMutation.mutate({
        clearComposer: false,
        collaborationMode: "plan",
        content: reviseLatestPlanPrompt(action.feedback),
        metadata: {
          action: "revisePlan",
          planMessageId: action.message.id,
          source: "proposedPlan",
        },
      })
    },
    [sendMutation],
  )

  const reviewFileChanges = useCallback(
    (action: FileChangePromptAction) => {
      sendMutation.mutate({
        clearComposer: false,
        collaborationMode: "default",
        content: action.prompt,
        metadata: {
          action: "reviewFileChanges",
          fileChangeMessageId: action.message.id,
          source: "fileChangeSummary",
        },
      })
    },
    [sendMutation],
  )

  const undoFileChanges = useCallback(
    (action: FileChangePromptAction) => {
      sendMutation.mutate({
        clearComposer: false,
        collaborationMode: "default",
        content: action.prompt,
        metadata: {
          action: "undoFileChanges",
          fileChangeMessageId: action.message.id,
          source: "fileChangeSummary",
        },
      })
    },
    [sendMutation],
  )

  useEffect(() => {
    if (!chatId) {
      return
    }

    const applyEvent = <TType extends ChatEventType>(
      type: TType,
      payload: ChatEventPayloads[TType],
    ) => {
      if (type === "chat.updated") {
        applyChatSnapshot(payload as ChatResponse)
        return
      }
      if (type === "context.updated") {
        setContextWindowUsage(payload as ContextWindowUsagePayload)
        return
      }
      queryClient.setQueryData<MessagePageResponse | undefined>(
        messagesQueryKey,
        (page) => applyChatEvent(page, type, payload),
      )
    }

    return connectChatEventSocket(session, chatId, {
      onClose: () => setStreamState("OFFLINE"),
      onError: (caught) => {
        setStreamState("OFFLINE")
        toast.error(readError(caught))
      },
      onEvent: applyEvent,
      onOpen: () => {
        setStreamState("ONLINE")
        const page =
          queryClient.getQueryData<MessagePageResponse>(messagesQueryKey)
        void getChatMessages(session, chatId, highestSequence(page))
          .then((next) => {
            next.data.forEach((message) => applyEvent("message.created", message))
          })
          .catch((caught) => toast.error(readError(caught)))
        void getChat(session, chatId)
          .then(applyChatSnapshot)
          .catch((caught) => toast.error(readError(caught)))
      },
    })

    function applyChatSnapshot(updatedChat: ChatResponse) {
      queryClient.setQueryData<ChatResponse | undefined>(
        chatQueryKey,
        updatedChat,
      )
      queryClient.setQueryData<ChatResponse[] | undefined>(
        ["chats"],
        (chats) =>
          chats?.map((chat) =>
            chat.id === updatedChat.id ? updatedChat : chat,
          ),
      )
    }
  }, [chatId, chatQueryKey, messagesQueryKey, queryClient, session])

  useEffect(() => {
    stickToBottomRef.current = true
    const frame = requestAnimationFrame(() => scrollToBottom("auto"))
    return () => cancelAnimationFrame(frame)
  }, [chatId, scrollToBottom])

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return
    }
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      scrollToBottom("auto")
      secondFrame = requestAnimationFrame(() => scrollToBottom("auto"))
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [scrollSignature, scrollToBottom])

  if (!chatId) {
    return <Navigate replace to="/" />
  }

  if (chatQuery.isLoading || messagesQuery.isLoading) {
    return <FullScreenLoader />
  }

  if (chatQuery.error) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-medium">Chat not available</div>
          <div className="mt-1 whitespace-pre-wrap">
            {chatQuery.error.message}
          </div>
        </div>
      </main>
    )
  }

  const chat = loadedChat
  const account = loadedAccount
  const isRunning = chat?.status === "RUNNING"
  const modelOptions = modelsQuery.data?.data ?? []
  const canSwitchAccount =
    !!chat && !isRunning && connectedAccounts.length > 0
  const selectedModel = selectedModelOption(modelOptions, chat?.model)
  const reasoningOptions =
    selectedModel?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort) ??
    []
  const activeReasoningEffort =
    chat?.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? null
  const serviceTierOptions = selectedModel?.additionalSpeedTiers ?? []
  const rateLimitSnapshot = selectRateLimitSnapshot(rateLimitsQuery.data)

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <OnlineStatusDot state={streamState} />
            <h1 className="truncate text-sm font-semibold tracking-normal">
              {chat?.title ?? "Chat"}
            </h1>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <UserRound className="size-3.5 shrink-0" />
              <span className="truncate">
                {account?.displayName ?? "No account selected"}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate">
                {chat?.workingDirectory ?? "No working directory"}
              </span>
            </span>
          </div>
        </div>
        {chat ? (
          <GitStatusChip
            chatId={chat.id}
            disabled={isRunning}
            session={session}
          />
        ) : null}
      </div>

      <ScrollArea
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
        viewportRef={scrollViewportRef}
        viewportProps={{
          className: "overflow-x-hidden",
          onScroll: (event) => {
            stickToBottomRef.current = isNearScrollBottom(event.currentTarget)
          },
        }}
      >
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 overflow-hidden px-4 pb-12 pt-6">
          {messages.length ? (
            <ChatTimeline
              chatId={chatId}
              fileChangeActionDisabled={isRunning}
              fileChangeActionPending={sendMutation.isPending}
              hiddenMessageIds={hiddenTimelineMessageIds}
              messages={messages}
              onImplementPlan={implementPlan}
              onRevisePlan={revisePlan}
              onReviewFileChanges={reviewFileChanges}
              onUndoFileChanges={undoFileChanges}
              planActionDisabled={isRunning}
              planActionPending={sendMutation.isPending}
              session={session}
            />
          ) : (
            <div className="py-20 text-center text-sm text-muted-foreground">
              No messages yet.
            </div>
          )}
        </div>
      </ScrollArea>

      <div
        className={cn(
          "min-w-0 border-t bg-background",
          terminalOpen && chat?.workingDirectory
            ? "overflow-y-auto max-sm:max-h-[calc(100svh-3.5rem)]"
            : "overflow-hidden",
        )}
      >
        {terminalOpen && chat?.workingDirectory ? (
          <div className="p-3">
            <div className="mx-auto max-w-5xl">
              <TerminalDock
                onClosePanel={() => setTerminalOpen(false)}
                projectPath={chat.workingDirectory}
                socket={terminalSocket}
                socketConnected={terminalSocketConnected}
              />
            </div>
          </div>
        ) : (
          <>
            <ChatComposerContextPanel
              chatId={chatId}
              messages={messages}
              session={session}
            />
            <div className="p-3">
          <div className="mx-auto grid min-w-0 max-w-3xl gap-2 overflow-hidden rounded-xl border bg-background p-2 shadow-sm">
            <Textarea
              className="max-h-44 min-h-20 resize-none border-0 px-1 shadow-none focus-visible:ring-0"
              placeholder={
                !chat?.workingDirectory
                  ? "Choose a directory first"
                  : account
                    ? "Message Codex"
                    : "Choose an account first"
              }
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  if (
                    canSend(content, chat?.workingDirectory ?? "", account, attachments)
                  ) {
                    sendMutation.mutate({
                      attachments: composerAttachmentsToRequest(attachments),
                      clearComposer: true,
                      delivery: isRunning ? "queue" : undefined,
                    })
                  }
                }
              }}
              onPaste={(event) => {
                const files = imageFilesFromClipboard(event.clipboardData)
                if (files.length) {
                  attachImages(files)
                }
              }}
            />
            <AttachmentTray
              attachments={attachments}
              imageInputRef={imageInputRef}
              onAttachImages={attachImages}
              onRemove={(id) =>
                setAttachments((current) =>
                  current.filter((attachment) => attachment.id !== id),
                )
              }
            />
            <div className="flex items-center justify-between gap-1 sm:gap-2">
              <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden sm:flex-wrap">
                <PlanModeSelector
                  attachmentDisabled={sendMutation.isPending}
                  disabled={!chat}
                  modeDisabled={isRunning}
                  mode={chat?.collaborationMode ?? "default"}
                  onAttachFile={attachWorkspaceFile}
                  onAttachImage={() => imageInputRef.current?.click()}
                  pending={updateRuntimeMutation.isPending}
                  steerDisabled={
                    !isRunning ||
                    sendMutation.isPending ||
                    !canSend(content, chat?.workingDirectory ?? "", account, attachments)
                  }
                  onSteerActiveTurn={() =>
                    sendMutation.mutate({
                      attachments: composerAttachmentsToRequest(attachments),
                      clearComposer: true,
                      delivery: "steer",
                    })
                  }
                  onSelectMode={(collaborationMode) =>
                    updateRuntimeMutation.mutate({ collaborationMode })
                  }
                />
                <CodexAccountSelector
                  account={account}
                  autoRotate={chat?.autoRotateAccount ?? false}
                  autoRotateDisabled={!chat || updateRuntimeMutation.isPending}
                  connectedAccounts={connectedAccounts}
                  disabled={!chat || !connectedAccounts.length}
                  pending={updateAccountMutation.isPending}
                  selectedAccountId={chat?.accountId ?? ""}
                  selectionDisabled={!canSwitchAccount}
                  usageSummaries={accountUsageSummaries}
                  onAutoRotateChange={(autoRotateAccount) =>
                    updateRuntimeMutation.mutate({ autoRotateAccount })
                  }
                  onSelect={(accountId) =>
                    updateAccountMutation.mutate({ accountId })
                  }
                />
                <ChatRuntimeSelector
                  activeReasoningEffort={activeReasoningEffort}
                  disabled={!chat || isRunning || !account}
                  modelOptions={modelOptions}
                  modelValue={chat?.model ?? ""}
                  pending={modelsQuery.isFetching || updateRuntimeMutation.isPending}
                  reasoningOptions={reasoningOptions}
                  reasoningValue={chat?.reasoningEffort ?? ""}
                  selectedModel={selectedModel}
                  serviceTierOptions={serviceTierOptions}
                  serviceTierValue={chat?.serviceTier ?? ""}
                  onSelectModel={(model) => {
                    if (chat?.accountId) {
                      updateAccountDefaultsMutation.mutate({
                        accountId: chat.accountId,
                        settings: {
                          defaultModel: model || null,
                          defaultReasoningEffort: null,
                          defaultServiceTier: null,
                        },
                      })
                    }
                    updateRuntimeMutation.mutate({
                      model: model || null,
                      reasoningEffort: null,
                      serviceTier: null,
                    })
                  }}
                  onSelectReasoning={(reasoningEffort) => {
                    const nextReasoningEffort = reasoningEffort
                      ? (reasoningEffort as CodexReasoningEffort)
                      : null
                    if (chat?.accountId) {
                      updateAccountDefaultsMutation.mutate({
                        accountId: chat.accountId,
                        settings: {
                          defaultModel: chat.model ?? null,
                          defaultReasoningEffort: nextReasoningEffort,
                          defaultServiceTier: chat.serviceTier ?? null,
                        },
                      })
                    }
                    updateRuntimeMutation.mutate({
                      reasoningEffort: nextReasoningEffort,
                    })
                  }}
                  onSelectServiceTier={(serviceTier) => {
                    const nextServiceTier = serviceTier
                      ? (serviceTier as CodexServiceTier)
                      : null
                    if (chat?.accountId) {
                      updateAccountDefaultsMutation.mutate({
                        accountId: chat.accountId,
                        settings: {
                          defaultModel: chat.model ?? null,
                          defaultReasoningEffort: chat.reasoningEffort ?? null,
                          defaultServiceTier: nextServiceTier,
                        },
                      })
                    }
                    updateRuntimeMutation.mutate({
                      serviceTier: nextServiceTier,
                    })
                  }}
                />
                <PermissionModeSelector
                  disabled={!chat}
                  mode={chat?.permissionMode ?? "default"}
                  pending={updateRuntimeMutation.isPending}
                  onSelectMode={(permissionMode) => {
                    if (chat?.accountId) {
                      updateAccountDefaultsMutation.mutate({
                        accountId: chat.accountId,
                        settings: { defaultPermissionMode: permissionMode },
                      })
                    }
                    updateRuntimeMutation.mutate({ permissionMode })
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                <ContextWindowPill usage={contextWindowUsage} />
                <UsageCapacityPill
                  pending={rateLimitsQuery.isFetching}
                  snapshot={rateLimitSnapshot}
                />
                <ComposerActionButton
                  loading={sendMutation.isPending}
                  running={isRunning}
                  sendDisabled={
                    !canSend(content, chat?.workingDirectory ?? "", account, attachments)
                  }
                  stopPending={interruptMutation.isPending}
                  onSend={() =>
                    sendMutation.mutate({
                      attachments: composerAttachmentsToRequest(attachments),
                      clearComposer: true,
                      delivery: isRunning ? "queue" : undefined,
                    })
                  }
                  onStop={() => interruptMutation.mutate()}
                />
              </div>
            </div>
          </div>
            </div>
          </>
        )}
      </div>
    </main>
  )
}

function FullScreenLoader() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function CodexAccountSelector({
  account,
  autoRotate,
  autoRotateDisabled,
  connectedAccounts,
  disabled,
  onAutoRotateChange,
  onSelect,
  pending,
  selectedAccountId,
  selectionDisabled,
  usageSummaries,
}: {
  account?: AccountResponse
  autoRotate?: boolean
  autoRotateDisabled?: boolean
  connectedAccounts: AccountResponse[]
  disabled?: boolean
  onAutoRotateChange?: (enabled: boolean) => void
  onSelect: (accountId: string) => void
  pending?: boolean
  selectedAccountId: string
  selectionDisabled?: boolean
  usageSummaries: Record<string, string>
}) {
  const label = autoRotate ? "Auto rotate" : account?.displayName ?? "Choose account"
  const title = autoRotate && account
    ? `Auto rotate: ${account.displayName}`
    : account?.displayName ?? "Choose account"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={title}
            className="max-w-44 justify-start max-sm:size-8 max-sm:justify-center max-sm:px-0"
            disabled={disabled || pending}
            size="sm"
            title={title}
            variant={autoRotate ? "secondary" : "ghost"}
          />
        }
      >
        {pending ? (
          <Loader2 className="animate-spin" />
        ) : autoRotate ? (
          <RefreshCw />
        ) : (
          <UserRound />
        )}
        <span className="truncate max-sm:sr-only">
          {label}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {onAutoRotateChange ? (
          <>
            <DropdownMenuItem
              className="gap-3 py-2"
              disabled={autoRotateDisabled || pending}
              onClick={(event) => {
                event.preventDefault()
                onAutoRotateChange(!autoRotate)
              }}
            >
              <RefreshCw />
              <span className="min-w-0 flex-1">Auto rotate</span>
              <Switch
                checked={!!autoRotate}
                className="pointer-events-none"
                size="sm"
                tabIndex={-1}
              />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {connectedAccounts.map((entry) => {
          const isSelected = entry.id === selectedAccountId
          return (
            <DropdownMenuItem
              disabled={pending || selectionDisabled}
              key={entry.id}
              onClick={() => {
                if (!isSelected) {
                  onSelect(entry.id)
                }
              }}
            >
              <span className="truncate">{entry.displayName}</span>
              {usageSummaries[entry.id] ? (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {usageSummaries[entry.id]}
                </span>
              ) : (
                <span className="ml-auto" />
              )}
              {isSelected ? <Check className="size-4 shrink-0" /> : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ContextWindowPill({
  usage,
}: {
  usage?: ContextWindowUsagePayload | null
}) {
  if (!usage || usage.tokenLimit <= 0) {
    return null
  }

  const usedPercent = clampPercent(usage.usedPercent)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={`Context ${Math.round(usedPercent)}% used`}
            className="size-7 px-0 text-xs font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent max-sm:size-8"
            size="icon-sm"
            title={`Context ${Math.round(usedPercent)}% used`}
            variant="ghost"
          />
        }
      >
        <span
          aria-hidden="true"
          className="grid size-4 shrink-0 place-items-center rounded-full text-foreground"
          style={{
            background: `conic-gradient(var(--foreground) ${usedPercent * 3.6}deg, var(--muted) 0deg)`,
          }}
        >
          <span className="size-2 rounded-full bg-background" />
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72" side="top">
        <PopoverHeader>
          <PopoverTitle>Context window</PopoverTitle>
          <PopoverDescription>
            Codex automatically compacts this context when needed.
          </PopoverDescription>
        </PopoverHeader>
        <div className="grid gap-3">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2 text-sm">
              <span className="font-medium">
                {Math.round(usedPercent)}% used
              </span>
              <span className="text-muted-foreground">
                {usage.remainingPercent}% left
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground"
                style={{ width: `${usedPercent}%` }}
              />
            </div>
          </div>
          <div className="rounded-md bg-muted/60 p-2 font-mono text-xs text-muted-foreground">
            {formatTokenCount(usage.tokensUsed)} /{" "}
            {formatTokenCount(usage.tokenLimit)} tokens used
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function OnlineStatusDot({ state }: { state: "OFFLINE" | "ONLINE" }) {
  const online = state === "ONLINE"
  return (
    <span
      aria-label={online ? "Realtime connected" : "Realtime disconnected"}
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        online ? "bg-emerald-500" : "bg-muted-foreground/45",
      )}
      title={online ? "Realtime connected" : "Realtime disconnected"}
    />
  )
}

function GitStatusChip({
  chatId,
  disabled,
  session,
}: {
  chatId: string
  disabled?: boolean
  session: WebSession
}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const statusQuery = useQuery({
    enabled: !!chatId,
    queryKey: ["git-status", chatId],
    queryFn: () => getGitStatus(session, chatId),
    refetchInterval: 20_000,
    retry: false,
  })
  const status = statusQuery.data
  if (status && !status.isRepo) {
    return null
  }
  const label = status?.branch ?? "Git"
  const dirty = status ? !status.clean : false
  const aheadBehind = status ? formatAheadBehind(status) : ""
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        className="h-7 max-w-56 justify-start gap-1.5 px-2 text-xs"
        disabled={statusQuery.isLoading && !status}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <GitBranch className="size-3.5" />
        <span className="min-w-0 truncate">{label}</span>
        {aheadBehind ? (
          <span className="shrink-0 text-muted-foreground">{aheadBehind}</span>
        ) : null}
        <span
          className={cn(
            "ml-0.5 size-1.5 shrink-0 rounded-full",
            dirty ? "bg-amber-500" : "bg-emerald-500",
          )}
        />
      </Button>
      {open ? (
        <GitDialog
          chatId={chatId}
          disabled={disabled}
          queryClient={queryClient}
          session={session}
          status={status}
        />
      ) : null}
    </Dialog>
  )
}

function GitDialog({
  chatId,
  disabled,
  queryClient,
  session,
  status,
}: {
  chatId: string
  disabled?: boolean
  queryClient: ReturnType<typeof useQueryClient>
  session: WebSession
  status?: GitStatusResponse
}) {
  const [branchFilter, setBranchFilter] = useState("")
  const [newBranchName, setNewBranchName] = useState("")
  const [commitMessage, setCommitMessage] = useState("")
  const branchesQuery = useQuery({
    enabled: !!chatId,
    queryKey: ["git-branches", chatId],
    queryFn: () => getGitBranches(session, chatId),
    retry: false,
  })
  const diffQuery = useQuery({
    enabled: !!chatId,
    queryKey: ["git-diff", chatId],
    queryFn: () => getGitDiff(session, chatId),
    retry: false,
  })
  const actionMutation = useMutation({
    mutationFn: runGitActionPayload,
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (response) => {
      toast.success(response.message)
      setCommitMessage("")
      setNewBranchName("")
      queryClient.setQueryData(["git-status", chatId], response.status)
      void queryClient.invalidateQueries({ queryKey: ["git-branches", chatId] })
      void queryClient.invalidateQueries({ queryKey: ["git-diff", chatId] })
    },
  })
  const branches = filterGitBranches(branchesQuery.data, branchFilter)
  const locked = disabled || actionMutation.isPending
  const currentStatus = status ?? actionMutation.data?.status

  function runGitActionPayload(body: Parameters<typeof runGitAction>[2]) {
    return runGitAction(session, chatId, body)
  }

  return (
    <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col overflow-hidden p-0">
      <DialogHeader className="gap-1 px-4 pb-2 pt-4">
        <DialogTitle>Git</DialogTitle>
        <DialogDescription className="truncate">
          {currentStatus?.root ?? "Repository information"}
        </DialogDescription>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 gap-0 overflow-hidden border-y md:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] border-b md:border-b-0 md:border-r">
          <div className="grid gap-2 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {currentStatus?.branch ?? "No branch"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {currentStatus ? formatGitSummary(currentStatus) : "Loading..."}
                </div>
              </div>
              <Button
                className="ml-auto"
                size="icon-sm"
                title="Refresh git"
                type="button"
                variant="ghost"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: ["git-status", chatId] })
                  void queryClient.invalidateQueries({ queryKey: ["git-branches", chatId] })
                  void queryClient.invalidateQueries({ queryKey: ["git-diff", chatId] })
                }}
              >
                <RefreshCw className={cn(actionMutation.isPending && "animate-spin")} />
              </Button>
            </div>
            <Input
              className="h-8"
              placeholder="Find branch"
              value={branchFilter}
              onChange={(event) => setBranchFilter(event.target.value)}
            />
          </div>
          <ScrollArea className="min-h-0">
            <div className="grid gap-1 p-2">
              {branches.map((branch) => (
                <Button
                  className="justify-start"
                  disabled={locked || branch.current}
                  key={branch.name}
                  size="sm"
                  type="button"
                  variant={branch.current ? "secondary" : "ghost"}
                  onClick={() => {
                    if (window.confirm(`Switch to ${branch.name}?`)) {
                      actionMutation.mutate({ action: "checkout", branch: branch.name })
                    }
                  }}
                >
                  <GitBranch />
                  <span className="min-w-0 truncate">{branch.name}</span>
                </Button>
              ))}
              {!branches.length ? (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No branches found.
                </div>
              ) : null}
            </div>
          </ScrollArea>
          <div className="grid gap-2 border-t p-3">
            <Input
              className="h-8"
              placeholder="New branch"
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.target.value)}
            />
            <Button
              disabled={locked || !newBranchName.trim()}
              size="sm"
              type="button"
              variant="outline"
              onClick={() =>
                actionMutation.mutate({
                  action: "createBranch",
                  branch: newBranchName.trim(),
                })
              }
            >
              <Plus />
              Create branch
            </Button>
          </div>
        </div>
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          <div className="grid gap-3 p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button
                disabled={locked}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  if (window.confirm("Pull with rebase and autostash?")) {
                    actionMutation.mutate({ action: "pull" })
                  }
                }}
              >
                <Download />
                Pull
              </Button>
              <Button
                disabled={locked}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  if (window.confirm("Push this branch?")) {
                    actionMutation.mutate({ action: "push" })
                  }
                }}
              >
                <Upload />
                Push
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                {actionMutation.isPending ? "Running git..." : formatGitSummary(currentStatus)}
              </span>
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
              <Textarea
                className="min-h-16 resize-y"
                placeholder="Commit message"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <Button
                className="self-end"
                disabled={locked || !commitMessage.trim() || currentStatus?.clean}
                type="button"
                onClick={() => {
                  if (window.confirm("Commit all changed files?")) {
                    actionMutation.mutate({
                      action: "commit",
                      message: commitMessage.trim(),
                    })
                  }
                }}
              >
                <GitCommitHorizontal />
                Commit
              </Button>
            </div>
          </div>
          <ScrollArea className="min-h-0 border-t">
            <div className="grid gap-3 p-3">
              <ChangedFilesList status={currentStatus} />
              <pre className="max-h-[46vh] min-w-0 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">
                {diffQuery.data?.diff?.trim() ||
                  diffQuery.data?.stat?.trim() ||
                  "No tracked diff."}
              </pre>
            </div>
          </ScrollArea>
        </div>
      </div>
    </DialogContent>
  )
}

function ChangedFilesList({ status }: { status?: GitStatusResponse }) {
  const files = status?.changedFiles ?? []
  if (!files.length) {
    return (
      <div className="rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
        Working tree clean.
      </div>
    )
  }
  return (
    <div className="grid max-h-40 gap-1 overflow-auto rounded-md border p-2">
      {files.map((file) => (
        <div
          className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-2 text-xs"
          key={`${file.status}:${file.path}`}
        >
          <span className="font-mono text-muted-foreground">{file.status}</span>
          <span className="min-w-0 truncate font-mono">{file.path}</span>
        </div>
      ))}
    </div>
  )
}

function filterGitBranches(
  response: GitBranchesResponse | undefined,
  filter: string,
) {
  const normalized = filter.trim().toLocaleLowerCase()
  const branches = response?.branches ?? []
  return normalized
    ? branches.filter((branch) => branch.name.toLocaleLowerCase().includes(normalized))
    : branches
}

function formatGitSummary(status?: GitStatusResponse): string {
  if (!status) {
    return "Git unavailable"
  }
  const parts = [
    status.clean ? "clean" : `${status.changedFiles.length} changed`,
    formatAheadBehind(status),
  ].filter(Boolean)
  return parts.join(" · ")
}

function formatAheadBehind(status: GitStatusResponse): string {
  const parts = []
  if (status.ahead) {
    parts.push(`+${status.ahead}`)
  }
  if (status.behind) {
    parts.push(`-${status.behind}`)
  }
  return parts.join(" ")
}

function UsageCapacityPill({
  pending,
  snapshot,
}: {
  pending: boolean
  snapshot?: CodexRateLimitSnapshot
}) {
  const label = usageCapacityLabel(snapshot)
  const severity = usageCapacitySeverity(snapshot)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className={cn(
              "h-7 max-w-36 justify-start px-2 text-xs font-normal text-foreground hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent max-sm:size-8 max-sm:justify-center max-sm:px-0",
              severity === "fiveHour" &&
                "border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-50 aria-expanded:bg-orange-50 dark:border-orange-900/70 dark:bg-orange-950/35 dark:text-orange-300 dark:hover:bg-orange-950/35 dark:aria-expanded:bg-orange-950/35",
              severity === "weekly" &&
                "border border-red-300 bg-red-50 text-red-700 hover:bg-red-50 aria-expanded:bg-red-50 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300 dark:hover:bg-red-950/35 dark:aria-expanded:bg-red-950/35",
            )}
            size="sm"
            title={label}
            variant="ghost"
          />
        }
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
        <span className="truncate max-sm:sr-only">{label}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" side="top">
        <PopoverHeader>
          <PopoverTitle>Usage capacity</PopoverTitle>
          <PopoverDescription>
            Current Codex account limits refresh automatically.
          </PopoverDescription>
        </PopoverHeader>
        <UsageCapacityDetails pending={pending} snapshot={snapshot} />
      </PopoverContent>
    </Popover>
  )
}

function PlanModeSelector({
  attachmentDisabled,
  disabled,
  mode,
  modeDisabled,
  onAttachFile,
  onAttachImage,
  onSelectMode,
  onSteerActiveTurn,
  pending,
  steerDisabled,
}: {
  attachmentDisabled?: boolean
  disabled?: boolean
  mode: CodexCollaborationMode
  modeDisabled?: boolean
  onAttachFile?: () => void
  onAttachImage?: () => void
  onSelectMode: (mode: CodexCollaborationMode) => void
  onSteerActiveTurn?: () => void
  pending?: boolean
  steerDisabled?: boolean
}) {
  const planEnabled = mode === "plan"
  const attachmentsLocked = attachmentDisabled || disabled
  const planLocked = disabled || modeDisabled || pending
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Chat options"
            className="shrink-0"
            disabled={disabled}
            size="icon-sm"
            variant={planEnabled ? "secondary" : "ghost"}
          />
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : <Plus />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          className="gap-3 py-2"
          disabled={planLocked}
          onClick={(event) => {
            event.preventDefault()
            onSelectMode(planEnabled ? "default" : "plan")
          }}
        >
          <ListChecks />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span>Plan mode</span>
          </span>
          <Switch
            checked={planEnabled}
            className="pointer-events-none"
            size="sm"
            tabIndex={-1}
          />
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-3 py-2"
          disabled={attachmentsLocked || !onAttachImage}
          onClick={onAttachImage}
        >
          <ImageIcon />
          <span>Attach image</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-3 py-2"
          disabled={attachmentsLocked || !onAttachFile}
          onClick={onAttachFile}
        >
          <Paperclip />
          <span>Attach workspace file</span>
        </DropdownMenuItem>
        {onSteerActiveTurn ? (
          <DropdownMenuItem
            className="gap-3 py-2"
            disabled={steerDisabled}
            onClick={onSteerActiveTurn}
          >
            <ArrowUp />
            <span>Steer active turn</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PermissionModeSelector({
  disabled,
  mode,
  onSelectMode,
  pending,
}: {
  disabled?: boolean
  mode: CodexPermissionMode
  onSelectMode: (mode: CodexPermissionMode) => void
  pending?: boolean
}) {
  const fullAccess = mode === "fullAccess"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={permissionModeLabel(mode)}
            className={cn(
              "max-w-40 justify-start max-sm:size-8 max-sm:justify-center max-sm:px-0",
              fullAccess &&
                "border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 aria-expanded:bg-orange-100 dark:border-orange-900/70 dark:bg-orange-950/35 dark:text-orange-300 dark:hover:bg-orange-950/45 dark:aria-expanded:bg-orange-950/45",
            )}
            disabled={disabled || pending}
            size="sm"
            title={permissionModeLabel(mode)}
            variant="ghost"
          />
        }
      >
        {pending ? (
          <Loader2 className="animate-spin" />
        ) : fullAccess ? (
          <ShieldCheck />
        ) : (
          <Shield />
        )}
        <span className="truncate max-sm:sr-only">{permissionModeLabel(mode)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) =>
            onSelectMode(value === "fullAccess" ? "fullAccess" : "default")
          }
        >
          <DropdownMenuRadioItem value="default">
            <span className="grid min-w-0 gap-0.5">
              <span>Default</span>
              <span className="text-xs text-muted-foreground">
                Codex asks as needed.
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem className="text-orange-700 dark:text-orange-300" value="fullAccess">
            <span className="grid min-w-0 gap-0.5">
              <span>Full access</span>
              <span className="text-xs text-muted-foreground">
                No sandbox or approval prompts.
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ComposerActionButton({
  loading,
  onSend,
  onStop,
  running = false,
  sendDisabled,
  stopPending = false,
}: {
  loading?: boolean
  onSend: () => void
  onStop?: () => void
  running?: boolean
  sendDisabled?: boolean
  stopPending?: boolean
}) {
  if (running) {
    return (
      <div className="flex items-center gap-1">
        <Button
          aria-label="Queue message"
          className="size-9 rounded-full"
          disabled={sendDisabled || loading}
          size="icon"
          title="Queue message"
          type="button"
          onClick={onSend}
        >
          {loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
        <Button
          aria-label="Stop task"
          className="size-9 rounded-full"
          disabled={stopPending || !onStop}
          size="icon"
          title="Stop task"
          type="button"
          variant="secondary"
          onClick={onStop}
        >
          {stopPending ? <Loader2 className="animate-spin" /> : <Square />}
        </Button>
      </div>
    )
  }

  return (
    <Button
      aria-label="Send message"
      className="size-9 rounded-full"
      disabled={sendDisabled || loading}
      size="icon"
      type="button"
      onClick={onSend}
    >
      {loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
    </Button>
  )
}

function ChatRuntimeSelector({
  activeReasoningEffort,
  disabled,
  modelOptions,
  modelValue,
  onSelectModel,
  onSelectReasoning,
  onSelectServiceTier,
  pending,
  reasoningOptions,
  reasoningValue,
  selectedModel,
  serviceTierOptions,
  serviceTierValue,
}: {
  activeReasoningEffort?: CodexReasoningEffort | null
  disabled: boolean
  modelOptions: CodexModelOption[]
  modelValue: string
  onSelectModel: (value: string) => void
  onSelectReasoning: (value: string) => void
  onSelectServiceTier: (value: string) => void
  pending: boolean
  reasoningOptions: CodexReasoningEffort[]
  reasoningValue: string
  selectedModel?: CodexModelOption
  serviceTierOptions: string[]
  serviceTierValue: string
}) {
  const summary = runtimeSummary({
    effort: activeReasoningEffort,
    model: selectedModel,
    modelValue,
    serviceTier: serviceTierValue,
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={summary}
            className="max-w-64 justify-start max-sm:size-8 max-sm:justify-center max-sm:px-0"
            disabled={disabled || pending}
            size="sm"
            title={summary}
            variant="ghost"
          />
        }
      >
        {pending ? <Loader2 className="animate-spin" /> : <Cpu />}
        <span className="truncate max-sm:sr-only">{summary}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,6rem)_auto]">
            <Brain />
            <span>Intelligence</span>
            <span className="truncate text-right text-xs text-muted-foreground">
              {formatEffortLabel(activeReasoningEffort)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuRadioGroup
              value={reasoningValue}
              onValueChange={onSelectReasoning}
            >
              <DropdownMenuRadioItem value="">
                Model default
              </DropdownMenuRadioItem>
              {reasoningOptions.map((effort) => (
                <DropdownMenuRadioItem key={effort} value={effort}>
                  {formatEffortLabel(effort)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,6rem)_auto]">
            <Cpu />
            <span>Model</span>
            <span className="truncate text-right text-xs text-muted-foreground">
              {(selectedModel?.displayName ?? modelValue) || "Default"}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <DropdownMenuRadioGroup value={modelValue} onValueChange={onSelectModel}>
              <DropdownMenuRadioItem value="">Default model</DropdownMenuRadioItem>
              {modelOptions.map((model) => (
                <DropdownMenuRadioItem key={model.id} value={model.model}>
                  <span className="truncate">{model.displayName}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,6rem)_auto]"
            disabled={!serviceTierOptions.length}
          >
            <Gauge />
            <span>Speed</span>
            <span className="truncate text-right text-xs text-muted-foreground">
              {formatServiceTierLabel(serviceTierValue)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuRadioGroup
              value={serviceTierValue}
              onValueChange={onSelectServiceTier}
            >
              <DropdownMenuRadioItem value="">Default speed</DropdownMenuRadioItem>
              {serviceTierOptions.map((tier) => (
                <DropdownMenuRadioItem key={tier} value={tier}>
                  {formatServiceTierLabel(tier)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UsageCapacityDetails({
  pending,
  snapshot,
}: {
  pending: boolean
  snapshot?: CodexRateLimitSnapshot
}) {
  if (!snapshot) {
    return (
      <div className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
        {pending ? "Loading limits..." : "Usage limits are unavailable."}
      </div>
    )
  }

  return (
    <div className="grid gap-2">
      <div className="grid gap-1 text-xs text-muted-foreground">
        {snapshot.limitName ? <div>{snapshot.limitName}</div> : null}
        {snapshot.planType ? <div>Plan: {formatPlanType(snapshot.planType)}</div> : null}
        {snapshot.credits ? (
          <div>
            Credits:{" "}
            {snapshot.credits.unlimited
              ? "unlimited"
              : snapshot.credits.balance ?? (snapshot.credits.hasCredits ? "available" : "depleted")}
          </div>
        ) : null}
        {snapshot.rateLimitReachedType ? (
          <div className="text-destructive">
            {formatRateLimitReached(snapshot.rateLimitReachedType)}
          </div>
        ) : null}
      </div>
      <CapacityRow
        fallbackLabel="5-hour limit"
        severity="fiveHour"
        window={snapshot.primary}
      />
      <CapacityRow
        fallbackLabel="Weekly limit"
        severity="weekly"
        window={snapshot.secondary}
      />
    </div>
  )
}

function CapacityRow({
  fallbackLabel,
  severity,
  window,
}: {
  fallbackLabel: string
  severity: "fiveHour" | "weekly"
  window?: CodexRateLimitWindow | null
}) {
  const usedPercent = clampPercent(window?.usedPercent ?? 0)
  const remainingPercent = Math.max(0, Math.round(100 - usedPercent))
  const reached = rateLimitWindowReached(window)

  return (
    <div
      className={cn(
        "grid gap-1.5 rounded-md border p-2",
        reached &&
          severity === "fiveHour" &&
          "border-orange-300 bg-orange-50/70 text-orange-800 dark:border-orange-900/70 dark:bg-orange-950/25 dark:text-orange-200",
        reached &&
          severity === "weekly" &&
          "border-red-300 bg-red-50/70 text-red-800 dark:border-red-900/70 dark:bg-red-950/25 dark:text-red-200",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {fullRateLimitWindowLabel(window, fallbackLabel)}
        </span>
        <span className={cn("text-muted-foreground", reached && "font-medium text-current")}>
          {window ? `${remainingPercent}% left` : "Unavailable"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-foreground",
            reached && severity === "fiveHour" && "bg-orange-500",
            reached && severity === "weekly" && "bg-red-500",
          )}
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground",
          reached && "text-current/80",
        )}
      >
        {window ? <span>{Math.round(usedPercent)}% used</span> : null}
        {window?.windowDurationMins ? (
          <span>{formatWindowDuration(window.windowDurationMins)}</span>
        ) : null}
        {window?.resetsAt ? (
          <span>Resets {formatResetTime(window.resetsAt)}</span>
        ) : null}
      </div>
    </div>
  )
}

function useShellContext() {
  return useOutletContext<ShellContext>()
}

function autoRotateTargetAccountForChat(
  chat: ChatResponse | undefined,
  account: AccountResponse | undefined,
  bestAvailableAccount: AccountResponse | undefined,
  snapshots: Record<string, CodexRateLimitSnapshot>,
): AccountResponse | null {
  if (
    !chat?.autoRotateAccount ||
    chat.status === "RUNNING" ||
    !bestAvailableAccount ||
    bestAvailableAccount.id === chat.accountId
  ) {
    return null
  }

  if (accountAvailabilityScore(snapshots[bestAvailableAccount.id]) < 0) {
    return null
  }

  const currentAccountUnavailable =
    !account ||
    account.status !== "CONNECTED" ||
    accountAvailabilityScore(snapshots[account.id]) < 0

  return currentAccountUnavailable ? bestAvailableAccount : null
}

function selectedModelOption(
  models: CodexModelOption[],
  value?: string | null,
): CodexModelOption | undefined {
  if (value) {
    return models.find((model) => model.model === value || model.id === value)
  }
  return models.find((model) => model.isDefault) ?? models[0]
}

function selectRateLimitSnapshot(
  response?: CodexRateLimitsResponse,
): CodexRateLimitSnapshot | undefined {
  return (
    response?.rateLimitsByLimitId?.codex ??
    Object.values(response?.rateLimitsByLimitId ?? {}).find(Boolean) ??
    response?.rateLimits
  )
}

function usageCapacityLabel(snapshot?: CodexRateLimitSnapshot): string {
  if (!snapshot) {
    return "Usage unavailable"
  }
  if (snapshot.credits?.unlimited) {
    return "Unlimited"
  }
  if (snapshot.rateLimitReachedType) {
    return "Limit reached"
  }
  const parts = [
    rateLimitSummary(snapshot.primary, "5h"),
    rateLimitSummary(snapshot.secondary, "W"),
  ]
    .filter(Boolean)
    .join(" · ")
  return parts || "Usage n/a"
}

function usageCapacitySeverity(
  snapshot?: CodexRateLimitSnapshot,
): "fiveHour" | "weekly" | null {
  if (!snapshot) {
    return null
  }
  if (rateLimitWindowReached(snapshot.secondary)) {
    return "weekly"
  }
  if (rateLimitWindowReached(snapshot.primary)) {
    return "fiveHour"
  }
  return null
}

function selectBestAvailableAccount(
  accounts: AccountResponse[],
  snapshots: Record<string, CodexRateLimitSnapshot>,
): AccountResponse | undefined {
  return accounts
    .map((account, index) => ({
      account,
      index,
      score: accountAvailabilityScore(snapshots[account.id]),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .at(0)?.account
}

function accountAvailabilityScore(snapshot?: CodexRateLimitSnapshot): number {
  if (!snapshot) {
    return 0
  }
  if (snapshot.rateLimitReachedType || usageCapacitySeverity(snapshot)) {
    return -1
  }
  if (snapshot.credits && !snapshot.credits.unlimited && !snapshot.credits.hasCredits) {
    return -1
  }
  if (snapshot.credits?.unlimited) {
    return 101
  }

  const remainingPercents = [snapshot.primary, snapshot.secondary]
    .filter((window): window is CodexRateLimitWindow => !!window)
    .map((window) => 100 - clampPercent(window.usedPercent))

  if (!remainingPercents.length) {
    return 0
  }
  return Math.min(...remainingPercents)
}

function rateLimitWindowReached(
  window: CodexRateLimitWindow | null | undefined,
): boolean {
  return clampPercent(window?.usedPercent ?? 0) >= 100
}

function rateLimitSummary(
  window: CodexRateLimitWindow | null | undefined,
  fallbackLabel: string,
): string | null {
  if (!window) {
    return null
  }
  const remainingPercent = Math.max(0, Math.round(100 - clampPercent(window.usedPercent)))
  return `${compactRateLimitWindowLabel(window, fallbackLabel)} ${remainingPercent}%`
}

function compactRateLimitWindowLabel(
  window: CodexRateLimitWindow | null | undefined,
  fallbackLabel: string,
): string {
  const minutes = window?.windowDurationMins
  if (!minutes) {
    return fallbackLabel
  }
  if (minutes >= 10_080) {
    return "W"
  }
  if (minutes === 300) {
    return "5h"
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`
  }
  return `${minutes}m`
}

function fullRateLimitWindowLabel(
  window: CodexRateLimitWindow | null | undefined,
  fallbackLabel: string,
): string {
  const minutes = window?.windowDurationMins
  if (!minutes) {
    return fallbackLabel
  }
  if (minutes >= 10_080) {
    return "Weekly limit"
  }
  if (minutes === 300) {
    return "5-hour limit"
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}-hour limit`
  }
  return `${minutes}-minute limit`
}

function formatWindowDuration(minutes: number): string {
  if (minutes >= 10_080) {
    return `${Math.round(minutes / 10_080)} week window`
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} hour window`
  }
  return `${minutes} minute window`
}

function formatResetTime(value: number): string {
  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(timestamp))
}

function formatChatListDate(value: string | Date): string {
  const date = new Date(value)
  const elapsedMs = Math.max(0, Date.now() - date.getTime())
  const minuteMs = 60 * 1000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs

  if (elapsedMs < 2 * minuteMs) {
    return "just now"
  }
  if (elapsedMs < hourMs) {
    return `${Math.floor(elapsedMs / minuteMs)}m ago`
  }
  if (elapsedMs < dayMs) {
    return `${Math.floor(elapsedMs / hourMs)}h ago`
  }
  if (elapsedMs < 2 * dayMs) {
    return "yesterday"
  }
  if (elapsedMs <= 3 * dayMs) {
    return `${Math.floor(elapsedMs / dayMs)} days ago`
  }

  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date)
}

function chatFolderName(workingDirectory?: string | null): string {
  const path = workingDirectory?.trim()
  if (!path) {
    return "No folder"
  }

  const trimmed = path.replace(/[\\/]+$/, "")
  if (!trimmed) {
    return path
  }

  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? trimmed
}

function displayNameForPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) || path
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${formatCompactNumber(value / 1_000_000)}M`
  }
  if (value >= 1_000) {
    return `${formatCompactNumber(value / 1_000)}k`
  }
  return String(Math.max(0, Math.round(value)))
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatPlanType(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
}

function formatRateLimitReached(value: string): string {
  return formatPlanType(value)
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
}

function runtimeSummary({
  effort,
  model,
  modelValue,
  serviceTier,
}: {
  effort?: CodexReasoningEffort | null
  model?: CodexModelOption
  modelValue: string
  serviceTier: string
}): string {
  return [
    (model?.displayName ?? modelValue) || "Model",
    effort ? formatEffortLabel(effort) : null,
    serviceTier ? formatServiceTierLabel(serviceTier) : null,
  ]
    .filter(Boolean)
    .join(" ")
}

function formatEffortLabel(value?: CodexReasoningEffort | null): string {
  if (!value) {
    return "Default"
  }
  if (value === "xhigh") {
    return "Extra High"
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function formatServiceTierLabel(value: string): string {
  if (!value) {
    return "Default"
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function permissionModeLabel(value: CodexPermissionMode): string {
  return value === "fullAccess" ? "Full access" : "Default"
}

function appendMessages(
  page: MessagePageResponse | undefined,
  messages: MessagePageResponse["data"],
): MessagePageResponse {
  let current = page
  for (const message of messages) {
    current = appendMessage(current, message)
  }
  return current ?? { data: [], nextCursor: null }
}

function executeResponseMessages(response: {
  assistantMessage?: MessagePageResponse["data"][number] | null
  message: MessagePageResponse["data"][number]
}): MessagePageResponse["data"] {
  return [response.message, response.assistantMessage].filter(
    (message): message is MessagePageResponse["data"][number] => !!message,
  )
}

function upsertAccount(
  accounts: AccountResponse[] | undefined,
  account: AccountResponse,
): AccountResponse[] {
  const existing = accounts ?? []
  if (existing.some((entry) => entry.id === account.id)) {
    return existing.map((entry) => (entry.id === account.id ? account : entry))
  }
  return [...existing, account]
}

function canSend(
  content: string,
  workingDirectory: string,
  account?: AccountResponse,
  attachments: ComposerAttachment[] = [],
) {
  return (!!content.trim() || attachments.length > 0) && !!workingDirectory.trim() && !!account
}

function readError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Request failed."
}
