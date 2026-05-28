import type { CodexRateLimitSnapshot } from "@/types"
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { ClipboardList, Loader2, Menu, Settings, SquarePen } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router"
import {
  ServerSettingsDialog,
  type ServerSettingsTab,
} from "@/components/server-settings-dialog"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Button } from "@/components/ui/button"
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
import { listAccounts, listChats, readCodexRateLimits } from "@/lib/api"
import { useDocumentTitle } from "@/lib/document-title"
import { selectRateLimitSnapshot, usageCapacityLabel } from "@/lib/rate-limits"
import { cn } from "@/lib/utils"
import { useSession } from "@/providers/session-provider"
import { useTerminalConnection } from "@/hooks/use-terminal-connection"
import { ChatSidebar } from "@/screens/components/chat-sidebar"
import { GitStatusChip } from "@/screens/components/git-status"
import {
  HeaderCreateMenu,
  HeaderTerminalButton,
} from "@/screens/components/header-menu"
import type { ShellContext } from "@/screens/shell-context"
import { isAccountTokenInvalidatedError } from "@/screens/chat-runtime-utils"

export function AppShell() {
  const { loading, session } = useSession()
  const { chatId } = useParams()
  const location = useLocation()
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
    refetchInterval: 5_000,
  })

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data])
  const chats = useMemo(() => chatsQuery.data ?? [], [chatsQuery.data])
  const activeChat = useMemo(() => {
    if (!chatId) {
      return null
    }
    return chats.find((chat) => chat.id === chatId) ?? null
  }, [chatId, chats])
  const workflowActive = location.pathname.startsWith("/workflow")
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
          const snapshot = selectRateLimitSnapshot(
            accountRateLimitQueries[index]?.data,
          )
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
              <SidebarGroupLabel>Workflow</SidebarGroupLabel>
              <SidebarGroupContent>
                <Button
                  className={cn(
                    "w-full justify-start",
                    workflowActive && "bg-sidebar-accent",
                  )}
                  variant="ghost"
                  onClick={() => navigate("/workflow")}
                >
                  <ClipboardList />
                  <span>Tasks</span>
                </Button>
              </SidebarGroupContent>
            </SidebarGroup>
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
                {workflowActive
                  ? "Workflow"
                  : activeChatTitle ?? (chatId ? "Chat" : "New chat")}
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
                onAddAccount={() =>
                  openAccountManagement({ focusCreate: true })
                }
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

function FullScreenLoader() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}
