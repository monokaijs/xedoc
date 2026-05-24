import type {
  AccountResponse,
  ChatResponse,
  CodexRateLimitSnapshot,
} from "@/types"
import type { WebSession } from "@/lib/session-storage"
import type { TerminalSocket } from "@/lib/terminal-socket"
import { useOutletContext } from "react-router"

export interface ShellContext {
  accounts: AccountResponse[]
  chats: ChatResponse[]
  accountRateLimitFetching: Record<string, boolean>
  accountRateLimitSnapshots: Record<string, CodexRateLimitSnapshot>
  accountUsageSummaries: Record<string, string>
  activeProjectPath: string
  connectedAccounts: AccountResponse[]
  lastOpenedChat: ChatResponse | null
  openAccountManagement: (options?: { focusCreate?: boolean }) => void
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

export function useShellContext() {
  return useOutletContext<ShellContext>()
}
