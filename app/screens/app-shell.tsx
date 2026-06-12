import type { ChatResponse, CodexRateLimitSnapshot } from "@/types"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  Folder,
  Loader2,
  Menu,
  Settings,
  SquarePen,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Navigate, Outlet, useNavigate, useParams } from "react-router"
import {
  ServerSettingsDialog,
  type ServerSettingsTab,
} from "@/components/server-settings-dialog"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { WorkspacePickerDialog } from "@/components/workspace-picker-dialog"
import {
  listAccounts,
  listChats,
  readCodexAccountRateLimits,
} from "@/lib/api"
import { useDocumentTitle } from "@/lib/document-title"
import { selectRateLimitSnapshot, usageCapacityLabel } from "@/lib/rate-limits"
import { cn } from "@/lib/utils"
import { useSession } from "@/providers/session-provider"
import { useTerminalConnection } from "@/hooks/use-terminal-connection"
import { ChatSidebar } from "@/screens/components/chat-sidebar"
import { GitStatusChip } from "@/screens/components/git-status"
import {
  HeaderAgentSoundButton,
  HeaderCreateMenu,
  HeaderTerminalButton,
} from "@/screens/components/header-menu"
import type { ShellContext } from "@/screens/shell-context"
import {
  chatFolderName,
  chatFolderPath,
  isConcreteFolderPath,
} from "@/screens/chat-runtime-utils"

const RECENT_FOLDER_LIMIT = 8

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
  const [gitOpen, setGitOpen] = useState(false)
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

  const openServerSettings = useCallback(
    (tab: ServerSettingsTab = "accounts") => {
      setServerSettingsTab(tab)
      setServerSettingsOpen(true)
    },
    [],
  )

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
    refetchInterval: (query) =>
      query.state.data?.some((chat) => chat.status === "RUNNING")
        ? 5_000
        : false,
  })

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data])
  const chats = useMemo(() => chatsQuery.data ?? [], [chatsQuery.data])
  const recentFolders = useMemo(() => recentChatFolders(chats), [chats])
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
    return null
  }, [chatId, chats, lastOpenedChatId])
  const connectedAccounts = useMemo(
    () => accounts.filter((account) => account.status === "CONNECTED"),
    [accounts],
  )
  const connectedAccountIds = useMemo(
    () => connectedAccounts.map((account) => account.id),
    [connectedAccounts],
  )
  useDocumentTitle(activeChatTitle)
  const accountRateLimitsQuery = useQuery({
    enabled: !!session && connectedAccountIds.length > 0,
    queryKey: ["rate-limits", connectedAccountIds],
    queryFn: () => readCodexAccountRateLimits(session!),
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  })
  const accountRateLimitSnapshots = useMemo(() => {
    return Object.fromEntries(
      connectedAccounts
        .map((account) => {
          const snapshot = selectRateLimitSnapshot(
            accountRateLimitsQuery.data?.data[account.id],
          )
          return snapshot ? [account.id, snapshot] : null
        })
        .filter((entry): entry is [string, CodexRateLimitSnapshot] => !!entry),
    )
  }, [accountRateLimitsQuery.data, connectedAccounts])
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
      connectedAccounts.map((account) => [
        account.id,
        accountRateLimitsQuery.isFetching,
      ]),
    )
  }, [accountRateLimitsQuery.isFetching, connectedAccounts])
  const invalidatedRateLimitAccountIds =
    accountRateLimitsQuery.data?.invalidatedAccountIds ?? []
  const invalidatedRateLimitAccountKey = invalidatedRateLimitAccountIds.join("|")

  useEffect(() => {
    if (invalidatedRateLimitAccountIds.length) {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] })
    }
  }, [
    invalidatedRateLimitAccountIds.length,
    invalidatedRateLimitAccountKey,
    queryClient,
  ])

  useEffect(() => {
    if (!activeProjectPath.trim()) {
      setTerminalOpen(false)
    }
  }, [activeProjectPath])

  useEffect(() => {
    if (!activeChat) {
      setGitOpen(false)
    }
  }, [activeChat])

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
    gitOpen,
    lastOpenedChat,
    openAccountManagement,
    openWorkspacePicker: setWorkspacePicker,
    session,
    setActiveProjectPath,
    setGitOpen,
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
            <NewChatSplitButton
              folders={recentFolders}
              onNewChat={(workingDirectory) =>
                navigate(
                  "/",
                  workingDirectory
                    ? { state: { workingDirectory } }
                    : undefined,
                )
              }
            />
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
                    active={gitOpen}
                    chatId={activeChat.id}
                    className="md:hidden"
                    compact
                    onToggle={() => setGitOpen(!gitOpen)}
                    session={session}
                  />
                </>
              ) : null}
              <HeaderCreateMenu
                onAddAccount={() =>
                  openAccountManagement({ focusCreate: true })
                }
                onNewChat={() => navigate("/")}
              />
              <HeaderAgentSoundButton />
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

type RecentChatFolder = {
  name: string
  path: string
}

function NewChatSplitButton({
  folders,
  onNewChat,
}: {
  folders: RecentChatFolder[]
  onNewChat: (workingDirectory?: string) => void
}) {
  return (
    <div className="flex w-full min-w-0 items-center">
      <Button
        className="min-w-0 flex-1 justify-start rounded-r-none border-sidebar-border"
        variant="ghost"
        onClick={() => onNewChat()}
      >
        <SquarePen />
        <span className="min-w-0 truncate">New chat</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label="New chat in recent folder"
              className="w-8 shrink-0 rounded-l-none border-l border-sidebar-border px-0"
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <ChevronDown className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
            Recent folders
          </div>
          {folders.length ? (
            folders.map((folder) => (
              <DropdownMenuItem
                className="min-w-0"
                key={folder.path}
                title={folder.path}
                onClick={() => onNewChat(folder.path)}
              >
                <Folder className="size-4" />
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              </DropdownMenuItem>
            ))
          ) : (
            <div className="px-1.5 py-2 text-xs text-muted-foreground">
              No recent folders.
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function recentChatFolders(chats: ChatResponse[]): RecentChatFolder[] {
  const folders: RecentChatFolder[] = []
  const seen = new Set<string>()
  for (const chat of [...chats].sort(compareChatsByCreated)) {
    const path = chatFolderPath(chat.workingDirectory)
    if (!isConcreteFolderPath(path) || seen.has(path)) {
      continue
    }
    seen.add(path)
    folders.push({
      name: chatFolderName(path),
      path,
    })
    if (folders.length >= RECENT_FOLDER_LIMIT) {
      break
    }
  }
  return folders
}

function compareChatsByCreated(left: ChatResponse, right: ChatResponse) {
  return (
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime() ||
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  )
}

function FullScreenLoader() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}
