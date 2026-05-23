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
  CodexReasoningEffort,
  CodexServiceTier,
  ExecuteChatRequest,
  MessagePageResponse,
  GitBranchesResponse,
  GitCommit,
  GitFileStatus,
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
  ChevronDown,
  Check,
  Clock,
  Cpu,
  File as FileIcon,
  FileDiff,
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
  useLocation,
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
import { Badge } from "@/components/ui/badge"
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { WorkspacePickerDialog } from "@/components/workspace-picker-dialog"
import {
  ApiError,
  appendMessage,
  archiveChat,
  createChat,
  executeChatMessage,
  getChatContext,
  getChat,
  getChatMessages,
  getGitBranches,
  getGitDiff,
  getGitHistory,
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
import { highlightCode } from "@/lib/highlight"
import {
  clampPercent,
  rateLimitWindowReached,
  selectRateLimitSnapshot,
  usageCapacityLabel,
  usageCapacitySeverity,
} from "@/lib/rate-limits"
import { cn } from "@/lib/utils"
import type { WebSession } from "@/lib/session-storage"
import { connectChatEventSocket } from "@/lib/socket"
import {
  connectTerminalSocket,
  type TerminalSocket,
} from "@/lib/terminal-socket"
import { useSession } from "@/providers/session-provider"
import "highlight.js/styles/github.css"

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
  accountRateLimitFetching: Record<string, boolean>
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
  terminalCount: number
  terminalOpen: boolean
  terminalSocket: TerminalSocket | null
  terminalSocketConnected: boolean
}

export function AppShell() {
  const { loading, session } = useSession()
  const { chatId } = useParams()
  const terminalConnection = useTerminalConnection(session)
  const [activeProjectPath, setActiveProjectPath] = useState("")
  const [lastOpenedChatId, setLastOpenedChatId] = useState<string | null>(null)
  const [accountCreateFocusKey, setAccountCreateFocusKey] = useState(0)
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [serverSettingsTab, setServerSettingsTab] =
    useState<ServerSettingsTab>("accounts")
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [workspacePicker, setWorkspacePicker] = useState<{
    initialPath?: string | null
    mode?: "directory" | "file"
    onSelect: (path: string) => void
  } | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

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

  const openServerSettings = useCallback((tab: ServerSettingsTab = "accounts") => {
    setServerSettingsTab(tab)
    setServerSettingsOpen(true)
  }, [])

  const accountsQuery = useQuery({
    enabled: !!session,
    queryKey: ["accounts"],
    queryFn: () => listAccounts(session!),
    refetchInterval: (query) =>
      query.state.data?.some((account) => account.status === "AUTHENTICATING")
        ? 1500
        : false,
  })

  const chatsQuery = useQuery({
    enabled: !!session,
    queryKey: ["chats"],
    queryFn: () => listChats(session!),
  })

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data])
  const chats = useMemo(() => chatsQuery.data ?? [], [chatsQuery.data])
  const activeChat = useMemo(() => {
    if (!chatId) {
      return null
    }
    return chats.find((chat) => chat.id === chatId) ?? null
  }, [chatId, chats])
  const activeChatTitle = activeChat?.title ?? null
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
  const accountRateLimitFetching = useMemo(() => {
    return Object.fromEntries(
      connectedAccounts.map((account, index) => [
        account.id,
        accountRateLimitQueries[index]?.isFetching ?? false,
      ]),
    )
  }, [accountRateLimitQueries, connectedAccounts])
  const hasInvalidatedRateLimitError = accountRateLimitQueries.some((query) =>
    isAccountTokenInvalidatedError(query.error),
  )

  useEffect(() => {
    if (hasInvalidatedRateLimitError) {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] })
    }
  }, [hasInvalidatedRateLimitError, queryClient])

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
    accountRateLimitFetching,
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
    terminalCount: terminalConnection.count,
    terminalOpen,
    terminalSocket: terminalConnection.socket,
    terminalSocketConnected: terminalConnection.connected,
  }

  return (
    <>
      <SidebarProvider className="h-svh min-h-0 overflow-hidden">
        <Sidebar collapsible="offcanvas" variant="inset">
          <SidebarHeader>
            <Button
              className="w-full justify-start"
              variant="ghost"
              onClick={() => navigate("/")}
            >
              <SquarePen />
              <span>New chat</span>
            </Button>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup className="p-0">
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
              <span>Settings</span>
            </Button>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <SidebarTrigger variant="ghost">
                <Menu />
              </SidebarTrigger>
              <h1 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-normal">
                {activeChatTitle ?? (chatId ? "Chat" : "New chat")}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {activeChat ? (
                <>
                  <HeaderTerminalButton
                    active={terminalOpen}
                    className={cn(
                      "md:hidden",
                      terminalOpen && "text-foreground",
                    )}
                    compact
                    count={terminalConnection.count}
                    disabled={!activeProjectPath.trim()}
                    onToggle={() => setTerminalOpen(!terminalOpen)}
                  />
                  <GitStatusChip
                    chatId={activeChat.id}
                    className="md:hidden"
                    compact
                    disabled={activeChat.status === "RUNNING"}
                    session={session}
                  />
                </>
              ) : null}
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

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Outlet context={shellContext} />
          </div>
        </SidebarInset>
      </SidebarProvider>

      <ServerSettingsDialog
        accounts={accounts}
        accountRateLimitFetching={accountRateLimitFetching}
        accountRateLimitSnapshots={accountRateLimitSnapshots}
        accountUsageSummaries={accountUsageSummaries}
        activeTab={serverSettingsTab}
        createFocusKey={accountCreateFocusKey}
        open={serverSettingsOpen}
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
  className,
  compact = false,
  count,
  disabled,
  onToggle,
}: {
  active: boolean
  className?: string
  compact?: boolean
  count?: number
  disabled: boolean
  onToggle: () => void
}) {
  const terminalCount = count ?? 0
  return (
    <Button
      aria-label="Terminal"
      aria-pressed={active}
      className={cn(
        compact
          ? "relative"
          : "h-7 max-w-56 justify-start gap-1.5 px-2 text-xs",
        className,
      )}
      disabled={disabled}
      size={compact ? "icon" : "sm"}
      title={disabled ? "Choose a working directory" : "Terminal"}
      type="button"
      variant="ghost"
      onClick={onToggle}
    >
      <TerminalIcon className="size-3.5" />
      <span className={compact ? "sr-only" : "min-w-0 truncate"}>Terminal</span>
      {terminalCount > 0 ? (
        <span
          className={cn(
            "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-sidebar-accent px-1 text-[0.65rem] leading-none text-sidebar-accent-foreground",
            compact
              ? "absolute -right-1 -top-1"
              : "ml-0.5",
          )}
        >
          {terminalCount}
        </span>
      ) : null}
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
      <DropdownMenuTrigger render={<Button size="icon" variant="ghost" />}>
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

const CHAT_GROUP_VISIBLE_LIMIT = 4

type ChatSidebarItem = {
  chat: ChatResponse
  dateLabel: string
  folderKey: string
  folderName: string
  folderPath: string
}

type ChatSidebarGroup = {
  items: ChatSidebarItem[]
  key: string
  latestActivityAt: number
  name: string
  path: string
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
  const [collapsedFolderKeys, setCollapsedFolderKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const [expandedFolderKeys, setExpandedFolderKeys] = useState<Set<string>>(
    () => new Set(),
  )

  const chatItems = useMemo(
    () =>
      chats.map((chat) => ({
        chat,
        dateLabel: formatChatListDate(chat.lastActivityAt),
        folderKey: chatFolderKey(chat.workingDirectory),
        folderName: chatFolderName(chat.workingDirectory),
        folderPath: chatFolderPath(chat.workingDirectory),
      })),
    [chats],
  )
  const chatGroups = useMemo<ChatSidebarGroup[]>(() => {
    const groups = new Map<string, ChatSidebarGroup>()
    for (const item of chatItems) {
      const activityTime = new Date(item.chat.lastActivityAt).getTime()
      const group = groups.get(item.folderKey)
      if (group) {
        group.items.push(item)
        group.latestActivityAt = Math.max(group.latestActivityAt, activityTime)
        continue
      }
      groups.set(item.folderKey, {
        items: [item],
        key: item.folderKey,
        latestActivityAt: activityTime,
        name: item.folderName,
        path: item.folderPath,
      })
    }
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        items: group.items.sort(
          (a, b) =>
            new Date(b.chat.lastActivityAt).getTime() -
              new Date(a.chat.lastActivityAt).getTime() ||
            a.chat.title.localeCompare(b.chat.title, undefined, {
              sensitivity: "base",
            }),
        ),
      }))
      .sort(
        (a, b) =>
          b.latestActivityAt - a.latestActivityAt ||
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
	            const visibleItems = groupExpanded
	              ? group.items
	              : group.items.slice(0, CHAT_GROUP_VISIBLE_LIMIT)
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
	                    <span className="min-w-0 flex-1 truncate">{group.name}</span>
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
	                          tooltip={`${chat.title} · ${dateLabel} · ${folderName}`}
	                          onClick={() => navigate(`/chat/${chat.id}`)}
	                        >
	                          <MessageSquare className="size-3.5 text-muted-foreground" />
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
	                    ) : groupExpanded && group.items.length > CHAT_GROUP_VISIBLE_LIMIT ? (
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
    accountRateLimitFetching,
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
  const location = useLocation()
  const routeWorkingDirectory = routeWorkingDirectoryFromState(location.state)
  const routeWorkingDirectoryKey = routeWorkingDirectory
    ? `${location.key}:${routeWorkingDirectory}`
    : ""
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
    routeWorkingDirectory || lastOpenedChat?.workingDirectory?.trim() || "",
  )
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const seededLastOpenedChatIdRef = useRef<string | null>(
    lastOpenedChat?.id ?? null,
  )
  const appliedRouteWorkingDirectoryRef = useRef<string | null>(
    routeWorkingDirectoryKey || null,
  )

  useEffect(() => {
    setActiveProjectPath(workingDirectory.trim())
    return () => setActiveProjectPath("")
  }, [setActiveProjectPath, workingDirectory])

  useEffect(() => {
    if (
      !routeWorkingDirectory ||
      appliedRouteWorkingDirectoryRef.current === routeWorkingDirectoryKey
    ) {
      return
    }
    appliedRouteWorkingDirectoryRef.current = routeWorkingDirectoryKey
    setWorkingDirectory(routeWorkingDirectory)
  }, [routeWorkingDirectory, routeWorkingDirectoryKey])

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
  useEffect(() => {
    if (isAccountTokenInvalidatedError(modelsQuery.error)) {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] })
    }
  }, [modelsQuery.error, queryClient])
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
  const rateLimitSnapshot = selectedConnectedAccount
    ? accountRateLimitSnapshots[selectedConnectedAccount.id]
    : undefined
  const rateLimitPending = selectedConnectedAccount
    ? !!accountRateLimitFetching[selectedConnectedAccount.id]
    : false

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
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        viewportProps={{ className: "overflow-x-hidden" }}
      >
        <div
          className={cn(
            "mx-auto flex min-h-full w-full flex-col px-4",
            showTerminalDock
              ? "max-w-5xl justify-start py-4 sm:justify-center sm:py-8"
              : "max-w-[760px] justify-center py-8",
          )}
      >
        {!connectedAccounts.length ? (
          <div className="mb-4 rounded-md border bg-muted/35 p-4 text-sm">
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
        <div className="grid gap-3 rounded-2xl border bg-card/80 p-3 shadow-sm dark:border-border/90 dark:bg-card/55">
          <div className="flex min-w-0 items-center gap-2 rounded-xl border bg-transparent px-2 py-1.5 dark:bg-transparent">
            <Input
              autoCapitalize="none"
              className="h-8 min-w-0 border-0 bg-transparent px-1 font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
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
          <div className="relative min-w-0">
            <ChatInputPlanModeBadge visible={collaborationMode === "plan"} />
            <Textarea
              className={cn(
                "min-h-32 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent",
                collaborationMode === "plan" && "pr-24",
              )}
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
          </div>
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
                pending={rateLimitPending}
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
      </ScrollArea>
    </main>
  )
}

export function ChatDetailPane() {
  const { chatId } = useParams()
  const {
    accounts,
    accountRateLimitFetching,
    accountRateLimitSnapshots,
    accountUsageSummaries,
    connectedAccounts,
    openWorkspacePicker,
    session,
    setActiveProjectPath,
    setTerminalOpen,
    terminalCount,
    terminalOpen,
    terminalSocket,
    terminalSocketConnected,
  } =
    useShellContext()
  const [content, setContent] = useState("")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
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
  useEffect(() => {
    if (isAccountTokenInvalidatedError(modelsQuery.error)) {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] })
    }
  }, [modelsQuery.error, queryClient])
  const rateLimitSnapshot = loadedAccount?.id
    ? accountRateLimitSnapshots[loadedAccount.id]
    : undefined
  const rateLimitPending = loadedAccount?.id
    ? !!accountRateLimitFetching[loadedAccount.id]
    : false

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
      if (type === "message.completed" || type === "message.failed") {
        void queryClient.invalidateQueries({ queryKey: messagesQueryKey })
        void queryClient.invalidateQueries({ queryKey: chatQueryKey })
        void queryClient.invalidateQueries({ queryKey: ["chats"] })
      }
    }

    return connectChatEventSocket(session, chatId, {
      onError: (caught) => toast.error(readError(caught)),
      onEvent: applyEvent,
      onOpen: () => {
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
    return (
      <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    )
  }

  if (chatQuery.error) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-6">
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

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-b-xl bg-background">
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
          <div className="p-2">
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
            <div className="p-2">
          <div className="mx-auto grid min-w-0 max-w-3xl gap-2 overflow-hidden rounded-xl border bg-background p-2 shadow-sm">
            <div className="relative min-w-0">
              <ChatInputPlanModeBadge
                visible={(chat?.collaborationMode ?? "default") === "plan"}
              />
              <Textarea
                className={cn(
                  "max-h-32 min-h-12 bg-transparent! text-xs resize-none border-0 px-1 shadow-none focus-visible:ring-0",
                  (chat?.collaborationMode ?? "default") === "plan" && "pr-24",
                )}
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
            </div>
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
                  pending={rateLimitPending}
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
      </div>
      {chat ? (
        <div className="hidden min-h-9 shrink-0 items-center justify-end gap-1 bg-sidebar px-3 py-1 md:-mb-2 md:flex">
          <HeaderTerminalButton
            active={terminalOpen}
            className={cn(
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              terminalOpen
                ? "text-sidebar-accent-foreground"
                : "text-sidebar-foreground/75",
            )}
            count={terminalCount}
            disabled={!chat.workingDirectory?.trim()}
            onToggle={() => setTerminalOpen(!terminalOpen)}
          />
          <GitStatusChip
            chatId={chat.id}
            className="text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground"
            disabled={isRunning}
            session={session}
          />
        </div>
      ) : null}
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

function GitStatusChip({
  chatId,
  className,
  compact = false,
  disabled,
  session,
}: {
  chatId: string
  className?: string
  compact?: boolean
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
        aria-label={`Git${label ? `: ${label}` : ""}`}
        className={cn(
          compact
            ? "relative"
            : "h-7 max-w-56 justify-start gap-1.5 px-2 text-xs",
          className,
        )}
        disabled={statusQuery.isLoading && !status}
        size={compact ? "icon" : "sm"}
        title={label}
        type="button"
        variant="ghost"
        onClick={() => setOpen(true)}
      >
        <GitBranch className="size-3.5" />
        {compact && status ? (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
              dirty ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
        ) : (
          <>
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
          </>
        )}
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
  const [commitMessage, setCommitMessage] = useState("")
  const [newBranchName, setNewBranchName] = useState("")
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const branchesQuery = useQuery({
    enabled: !!chatId,
    queryKey: ["git-branches", chatId],
    queryFn: () => getGitBranches(session, chatId),
    retry: false,
  })
  const diffQuery = useQuery({
    enabled: !!chatId,
    queryKey: ["git-diff", chatId, selectedFilePath],
    queryFn: () => getGitDiff(session, chatId, selectedFilePath),
    retry: false,
  })
  const historyQuery = useQuery({
    enabled: !!chatId,
    queryKey: ["git-history", chatId],
    queryFn: () => getGitHistory(session, chatId),
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
      void queryClient.invalidateQueries({ queryKey: ["git-history", chatId] })
    },
  })
  const branches = filterGitBranches(branchesQuery.data, branchFilter)
  const currentStatus = actionMutation.data?.status ?? status
  const changedFiles = useMemo(
    () => currentStatus?.changedFiles ?? [],
    [currentStatus],
  )
  const commits = useMemo(
    () => historyQuery.data?.commits ?? [],
    [historyQuery.data],
  )
  const selectedCommit =
    commits.find((commit) => commit.hash === selectedCommitHash) ?? null
  const locked =
    disabled || actionMutation.isPending || !currentStatus || currentStatus.isRepo === false
  const diffText =
    diffQuery.data?.diff?.trim() || diffQuery.data?.stat?.trim() || ""
  const diffTitle = selectedFilePath ?? "All changes"

  useEffect(() => {
    setSelectedFilePath((current) => {
      if (!changedFiles.length) {
        return null
      }
      if (current && changedFiles.some((file) => file.path === current)) {
        return current
      }
      return changedFiles[0]?.path ?? null
    })
  }, [changedFiles])

  useEffect(() => {
    setSelectedCommitHash((current) => {
      if (!commits.length) {
        return null
      }
      if (current && commits.some((commit) => commit.hash === current)) {
        return current
      }
      return commits[0]?.hash ?? null
    })
  }, [commits])

  function runGitActionPayload(body: Parameters<typeof runGitAction>[2]) {
    return runGitAction(session, chatId, body)
  }

  return (
    <DialogContent className="flex h-[min(90vh,760px)] w-[min(1180px,calc(100vw-1rem))] max-w-none flex-col overflow-hidden p-0">
      <DialogHeader className="gap-2 px-4 pb-3 pr-12 pt-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DialogTitle className="flex min-w-0 items-center gap-2 text-base">
            <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
            <span>Git</span>
          </DialogTitle>
          <GitBranchPopover
            branches={branches}
            branchFilter={branchFilter}
            currentBranch={currentStatus?.branch}
            loading={branchesQuery.isFetching && !branchesQuery.data}
            locked={locked}
            newBranchName={newBranchName}
            onBranchFilterChange={setBranchFilter}
            onCheckout={(branch) => {
              if (window.confirm(`Switch to ${branch}?`)) {
                actionMutation.mutate({ action: "checkout", branch })
              }
            }}
            onCreateBranch={() =>
              actionMutation.mutate({
                action: "createBranch",
                branch: newBranchName.trim(),
              })
            }
            onNewBranchNameChange={setNewBranchName}
          />
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              currentStatus
                ? currentStatus.clean
                  ? "bg-emerald-500"
                  : "bg-amber-500"
                : "bg-muted-foreground/40",
            )}
          />
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {actionMutation.isPending
              ? "Running git..."
              : currentStatus
                ? formatGitSummary(currentStatus)
                : "Loading..."}
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-1">
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
            <Button
              size="icon-sm"
              title="Refresh git"
              type="button"
              variant="ghost"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ["git-status", chatId] })
                void queryClient.invalidateQueries({ queryKey: ["git-branches", chatId] })
                void queryClient.invalidateQueries({ queryKey: ["git-diff", chatId] })
                void queryClient.invalidateQueries({ queryKey: ["git-history", chatId] })
              }}
            >
              <RefreshCw
                className={cn(
                  (actionMutation.isPending ||
                    diffQuery.isFetching ||
                    historyQuery.isFetching) &&
                    "animate-spin",
                )}
              />
            </Button>
          </div>
        </div>
        <DialogDescription className="sr-only">
          Manage repository changes, branches, commits, pull, push, and history.
        </DialogDescription>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 overflow-y-auto border-t lg:grid-cols-[18rem_minmax(0,1fr)_19rem] lg:overflow-hidden">
        <section className="grid min-h-[20rem] grid-rows-[auto_minmax(0,1fr)_auto] border-b lg:min-h-0 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <ListChecks className="size-4 text-muted-foreground" />
              <div className="truncate text-sm font-medium">Local Changes</div>
            </div>
            <span className="text-xs text-muted-foreground">
              {changedFiles.length}
            </span>
          </div>
          <ScrollArea className="min-h-0">
            <ChangedFilesList
              files={changedFiles}
              loading={!currentStatus}
              selectedPath={selectedFilePath}
              onSelect={setSelectedFilePath}
            />
          </ScrollArea>
          <div className="grid gap-2 border-t p-3">
            <Textarea
              className="min-h-20 resize-none text-sm"
              placeholder="Commit message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            <Button
              className="justify-center"
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
              Commit All
            </Button>
          </div>
        </section>

        <section className="grid min-h-[24rem] min-w-0 grid-rows-[auto_minmax(0,1fr)] border-b lg:min-h-0 lg:border-b-0 lg:border-r">
          <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
            <FileDiff className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">Diff Preview</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {diffTitle}
              </div>
            </div>
            {selectedFilePath ? (
              <Button
                size="xs"
                type="button"
                variant="ghost"
                onClick={() => setSelectedFilePath(null)}
              >
                All
              </Button>
            ) : null}
          </div>
          <div className="min-h-0 min-w-0 overflow-auto bg-muted/20">
            <GitDiffViewer
              diff={diffQuery.data?.diff ?? ""}
              error={diffQuery.error}
              fallback={diffQuery.data?.stat ?? ""}
              loading={diffQuery.isFetching && !diffText}
            />
          </div>
        </section>

        <section className="grid min-h-[22rem] grid-rows-[auto_minmax(0,1fr)_auto] lg:min-h-0">
          <div className="flex min-w-0 items-center justify-between gap-2 border-b px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Clock className="size-4 text-muted-foreground" />
              <div className="truncate text-sm font-medium">History</div>
            </div>
            <span className="text-xs text-muted-foreground">{commits.length}</span>
          </div>
          <GitHistoryPanel
            commits={commits}
            error={historyQuery.error}
            fetching={historyQuery.isFetching}
            selectedHash={selectedCommitHash}
            onSelect={setSelectedCommitHash}
          />
          <div className="min-h-20 border-t p-3 text-xs">
            {selectedCommit ? (
              <div className="grid gap-1">
                <div className="line-clamp-2 font-medium">
                  {selectedCommit.subject}
                </div>
                <div className="truncate font-mono text-muted-foreground">
                  {selectedCommit.hash}
                </div>
                <div className="truncate text-muted-foreground">
                  {selectedCommit.authorName || "Unknown author"} ·{" "}
                  {formatGitCommitDate(selectedCommit.authoredAt)}
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground">No commit selected.</div>
            )}
          </div>
        </section>
      </div>
    </DialogContent>
  )
}

function GitBranchPopover({
  branches,
  branchFilter,
  currentBranch,
  loading,
  locked,
  newBranchName,
  onBranchFilterChange,
  onCheckout,
  onCreateBranch,
  onNewBranchNameChange,
}: {
  branches: GitBranchesResponse["branches"]
  branchFilter: string
  currentBranch?: string | null
  loading: boolean
  locked: boolean
  newBranchName: string
  onBranchFilterChange: (value: string) => void
  onCheckout: (branch: string) => void
  onCreateBranch: () => void
  onNewBranchNameChange: (value: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className="max-w-64 justify-start"
            size="sm"
            type="button"
            variant="outline"
          />
        }
      >
        <GitBranch />
        <span className="min-w-0 truncate">{currentBranch ?? "No branch"}</span>
        <ChevronDown className="ml-1 size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-0 p-0" side="bottom">
        <PopoverHeader className="border-b p-3">
          <PopoverTitle>Branches</PopoverTitle>
          <PopoverDescription>
            Current branch: {currentBranch ?? "detached"}
          </PopoverDescription>
        </PopoverHeader>
        <div className="grid gap-2 p-3">
          <Input
            className="h-8"
            placeholder="Find branch"
            value={branchFilter}
            onChange={(event) => onBranchFilterChange(event.target.value)}
          />
        </div>
        <ScrollArea className="max-h-72 border-y">
          <div className="grid gap-1 p-2">
            {branches.map((branch) => (
              <Button
                className="justify-start"
                disabled={locked || branch.current}
                key={branch.name}
                size="sm"
                type="button"
                variant={branch.current ? "secondary" : "ghost"}
                onClick={() => onCheckout(branch.name)}
              >
                {branch.current ? <Check /> : <GitBranch />}
                <span className="min-w-0 truncate">{branch.name}</span>
              </Button>
            ))}
            {!branches.length ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                {loading ? "Loading branches..." : "No branches found."}
              </div>
            ) : null}
          </div>
        </ScrollArea>
        <div className="grid gap-2 p-3">
          <Input
            className="h-8"
            placeholder="New branch"
            value={newBranchName}
            onChange={(event) => onNewBranchNameChange(event.target.value)}
          />
          <Button
            disabled={locked || !newBranchName.trim()}
            size="sm"
            type="button"
            variant="outline"
            onClick={onCreateBranch}
          >
            <Plus />
            Create branch
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ChangedFilesList({
  files,
  loading,
  selectedPath,
  onSelect,
}: {
  files: GitFileStatus[]
  loading: boolean
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  if (loading) {
    return (
      <div className="m-3 rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
        Loading status...
      </div>
    )
  }
  if (!files.length) {
    return (
      <div className="m-3 rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
        Working tree clean.
      </div>
    )
  }
  return (
    <div className="grid gap-1 p-2">
      {files.map((file) => (
        <button
          className={cn(
            "grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted",
            selectedPath === file.path && "bg-muted",
          )}
          key={`${file.status}:${file.path}`}
          type="button"
          onClick={() => onSelect(file.path)}
        >
          <span
            className={cn(
              "rounded-sm px-1 py-0.5 text-center font-mono text-[0.68rem]",
              gitStatusClassName(file.status),
            )}
          >
            {file.status.trim()}
          </span>
          <span className="min-w-0 truncate font-mono">{file.path}</span>
        </button>
      ))}
    </div>
  )
}

type DiffFile = {
  hunks: DiffHunk[]
  language: string | null
  meta: string[]
  path: string
}

type DiffHunk = {
  header: string
  lines: DiffLine[]
}

type DiffLine = {
  content: string
  newNumber: number | null
  oldNumber: number | null
  type: "add" | "context" | "delete" | "meta"
}

function GitDiffViewer({
  diff,
  error,
  fallback,
  loading,
}: {
  diff: string
  error: unknown
  fallback: string
  loading: boolean
}) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])

  if (error) {
    return (
      <div className="p-3 font-mono text-xs text-destructive">
        {readError(error)}
      </div>
    )
  }
  if (loading) {
    return (
      <div className="p-3 font-mono text-xs text-muted-foreground">
        Loading diff...
      </div>
    )
  }
  if (!files.length) {
    return (
      <pre className="min-h-full min-w-0 overflow-auto p-3 font-mono text-xs leading-5 text-muted-foreground">
        {fallback.trim() || "No tracked diff."}
      </pre>
    )
  }

  return (
    <div className="min-w-max divide-y">
      {files.map((file) => (
        <section key={file.path} className="bg-background">
          <div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2 backdrop-blur">
            <div className="flex min-w-0 items-center gap-2">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs font-medium">
                {file.path}
              </span>
            </div>
            {file.meta.length ? (
              <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-[0.68rem] text-muted-foreground">
                {file.meta.slice(0, 3).map((line) => (
                  <span className="truncate" key={line}>
                    {line}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="py-1 font-mono text-xs leading-5">
            {file.hunks.map((hunk, index) => (
              <div key={`${file.path}:${index}`}>
                <div className="grid grid-cols-[4.5rem_1.25rem_minmax(24rem,1fr)] border-y bg-muted/70 text-[0.68rem] text-muted-foreground">
                  <div className="border-r px-2 py-1 text-right">line</div>
                  <div />
                  <div className="whitespace-pre px-2 py-1">{hunk.header}</div>
                </div>
                {hunk.lines.map((line, lineIndex) => (
                  <DiffViewerLine
                    fileLanguage={file.language}
                    key={`${file.path}:${index}:${lineIndex}`}
                    line={line}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function DiffViewerLine({
  fileLanguage,
  line,
}: {
  fileLanguage: string | null
  line: DiffLine
}) {
  const prefix =
    line.type === "add"
      ? "+"
      : line.type === "delete"
        ? "-"
        : line.type === "meta"
          ? "\\"
          : " "
  const lineNumber =
    line.type === "delete" ? line.oldNumber : line.newNumber ?? line.oldNumber
  const highlighted =
    line.type === "meta"
      ? escapeHtml(line.content)
      : highlightCode(line.content || " ", fileLanguage)

  return (
    <div
      className={cn(
        "grid grid-cols-[4.5rem_1.25rem_minmax(24rem,1fr)] border-l-2",
        line.type === "add" &&
          "border-l-emerald-500 bg-emerald-500/10 text-emerald-950 dark:text-emerald-50",
        line.type === "delete" &&
          "border-l-red-500 bg-red-500/10 text-red-950 dark:text-red-50",
        line.type === "context" && "border-l-transparent bg-background",
        line.type === "meta" && "border-l-transparent bg-muted/40 text-muted-foreground",
      )}
    >
      <div className="select-none border-r px-2 text-right text-[0.68rem] text-muted-foreground">
        {lineNumber ?? ""}
      </div>
      <div className="select-none px-2 text-center text-muted-foreground">
        {prefix}
      </div>
      <div
        className="whitespace-pre px-2"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  )
}

function parseUnifiedDiff(diff: string): DiffFile[] {
  const trimmed = diff.trim()
  if (!trimmed) {
    return []
  }
  return splitUnifiedDiffFiles(trimmed)
    .map(parseUnifiedDiffFile)
    .filter((file): file is DiffFile => !!file)
}

function splitUnifiedDiffFiles(diff: string): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && current.length) {
      chunks.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length) {
    chunks.push(current)
  }
  return chunks
}

function parseUnifiedDiffFile(lines: string[]): DiffFile | null {
  const path = diffPathFromLines(lines)
  if (!path) {
    return null
  }
  const file: DiffFile = {
    hunks: [],
    language: languageFromPath(path),
    meta: [],
    path,
  }
  let currentHunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const range = parseHunkRange(line)
      oldLine = range.oldStart
      newLine = range.newStart
      currentHunk = { header: line, lines: [] }
      file.hunks.push(currentHunk)
      continue
    }

    if (!currentHunk) {
      if (
        !line.startsWith("diff --git ") &&
        !line.startsWith("--- ") &&
        !line.startsWith("+++ ")
      ) {
        file.meta.push(line)
      }
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({
        content: line.slice(1),
        newNumber: newLine,
        oldNumber: null,
        type: "add",
      })
      newLine += 1
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({
        content: line.slice(1),
        newNumber: null,
        oldNumber: oldLine,
        type: "delete",
      })
      oldLine += 1
    } else if (line.startsWith("\\")) {
      currentHunk.lines.push({
        content: line,
        newNumber: null,
        oldNumber: null,
        type: "meta",
      })
    } else {
      currentHunk.lines.push({
        content: line.startsWith(" ") ? line.slice(1) : line,
        newNumber: newLine,
        oldNumber: oldLine,
        type: "context",
      })
      oldLine += 1
      newLine += 1
    }
  }

  return file.hunks.length ? file : null
}

function diffPathFromLines(lines: string[]): string | null {
  for (const prefix of ["+++ ", "--- "]) {
    for (const line of lines) {
      if (!line.startsWith(prefix)) {
        continue
      }
      const path = normalizeDiffPath(line.slice(prefix.length))
      if (path && path !== "/dev/null") {
        return path
      }
    }
  }
  const header = lines.find((line) => line.startsWith("diff --git "))
  const parts = header?.split(/\s+/) ?? []
  return normalizeDiffPath(parts[3] ?? parts[2] ?? "")
}

function normalizeDiffPath(path: string): string | null {
  const trimmed = path.trim().replace(/^"|"$/g, "")
  if (!trimmed) {
    return null
  }
  return trimmed.replace(/^[ab]\//, "")
}

function parseHunkRange(header: string): { oldStart: number; newStart: number } {
  const match = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  return {
    newStart: Number(match?.[2] ?? 0),
    oldStart: Number(match?.[1] ?? 0),
  }
}

function languageFromPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLocaleLowerCase()
  switch (extension) {
    case "bash":
    case "sh":
      return "bash"
    case "css":
      return "css"
    case "go":
      return "go"
    case "htm":
    case "html":
    case "svg":
    case "xml":
      return "xml"
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript"
    case "json":
      return "json"
    case "md":
    case "mdx":
      return "markdown"
    case "py":
      return "python"
    case "rs":
      return "rust"
    case "sql":
      return "sql"
    case "ts":
    case "tsx":
      return "typescript"
    case "yaml":
    case "yml":
      return "yaml"
    default:
      return null
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function GitHistoryPanel({
  commits,
  error,
  fetching,
  selectedHash,
  onSelect,
}: {
  commits: GitCommit[]
  error: unknown
  fetching: boolean
  selectedHash: string | null
  onSelect: (hash: string) => void
}) {
  if (error) {
    return (
      <div className="p-3 text-xs text-destructive">{readError(error)}</div>
    )
  }
  if (fetching && !commits.length) {
    return (
      <div className="p-3 text-xs text-muted-foreground">Loading history...</div>
    )
  }
  if (!commits.length) {
    return (
      <div className="p-3 text-xs text-muted-foreground">No commits found.</div>
    )
  }
  return (
    <ScrollArea className="min-h-0">
      <div className="grid gap-1 p-2">
        {commits.map((commit) => (
          <button
            className={cn(
              "grid gap-1 rounded-md px-2 py-2 text-left outline-none hover:bg-muted focus-visible:bg-muted",
              selectedHash === commit.hash && "bg-muted",
            )}
            key={commit.hash}
            type="button"
            onClick={() => onSelect(commit.hash)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {commit.subject}
              </span>
              <span className="shrink-0 font-mono text-[0.68rem] text-muted-foreground">
                {commit.shortHash}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-[0.68rem] text-muted-foreground">
              <span className="min-w-0 truncate">
                {commit.authorName || "Unknown author"}
              </span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">{formatGitCommitDate(commit.authoredAt)}</span>
            </div>
            {commit.refs.length ? (
              <div className="flex min-w-0 flex-wrap gap-1">
                {commit.refs.slice(0, 3).map((ref) => (
                  <span
                    className="max-w-full truncate rounded bg-secondary px-1.5 py-0.5 text-[0.65rem] text-secondary-foreground"
                    key={ref}
                  >
                    {ref}
                  </span>
                ))}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    </ScrollArea>
  )
}

function gitStatusClassName(status: string): string {
  if (status.includes("D")) {
    return "bg-red-500/10 text-red-700 dark:text-red-300"
  }
  if (status.includes("A") || status.includes("?")) {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (status.includes("R") || status.includes("C")) {
    return "bg-blue-500/10 text-blue-700 dark:text-blue-300"
  }
  return "bg-amber-500/10 text-amber-700 dark:text-amber-300"
}

function formatGitCommitDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown date"
  }
  return date.toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  })
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

function ChatInputPlanModeBadge({ visible }: { visible: boolean }) {
  if (!visible) {
    return null
  }
  return (
    <Badge
      className="pointer-events-none absolute right-1.5 top-1.5 z-10 border-primary/25 bg-background/95 text-foreground shadow-sm backdrop-blur dark:border-primary/40"
      variant="outline"
    >
      <ListChecks />
      <span>Plan mode</span>
    </Badge>
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

function chatFolderPath(workingDirectory?: string | null): string {
  const path = workingDirectory?.trim()
  if (!path) {
    return "No folder"
  }
  return path.replace(/[\\/]+$/, "") || path
}

function chatFolderKey(workingDirectory?: string | null): string {
  return chatFolderPath(workingDirectory)
}

function isConcreteFolderPath(path: string): boolean {
  return !!path.trim() && path !== "No folder"
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

function routeWorkingDirectoryFromState(state: unknown): string {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return ""
  }
  const value = (state as { workingDirectory?: unknown }).workingDirectory
  return typeof value === "string" ? value.trim() : ""
}

function isAccountTokenInvalidatedError(error: unknown): boolean {
  if (!error) {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return (
    (error instanceof ApiError && error.status === 401) ||
    /token_invalidated|authentication token .*invalidated|re-authenticate this account/i.test(
      message,
    )
  )
}

function readError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Request failed."
}
