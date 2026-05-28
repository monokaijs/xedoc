import type { AccountResponse, CodexRateLimitSnapshot } from "@/types"
import type { ReactNode } from "react"
import {
  ExternalLink,
  Info,
  Mail,
  UserRound,
} from "lucide-react"
import { AccountManagementPanel } from "@/components/account-management-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { WebSession } from "@/lib/session-storage"

export type ServerSettingsTab = "accounts" | "info"

export function ServerSettingsDialog({
  accounts,
  accountRateLimitFetching,
  accountRateLimitSnapshots,
  accountUsageSummaries,
  activeTab,
  createFocusKey,
  onOpenChange,
  onTabChange,
  open,
  session,
}: {
  accounts: AccountResponse[]
  accountRateLimitFetching: Record<string, boolean>
  accountRateLimitSnapshots: Record<string, CodexRateLimitSnapshot>
  accountUsageSummaries: Record<string, string>
  activeTab: ServerSettingsTab
  createFocusKey: number
  onOpenChange: (open: boolean) => void
  onTabChange: (tab: ServerSettingsTab) => void
  open: boolean
  session: WebSession
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl gap-0 overflow-hidden p-0">
        <DialogHeader className="px-5 py-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Manage accounts and project details.
          </DialogDescription>
        </DialogHeader>

        <Separator />

        <div className="grid min-h-0 md:grid-cols-[11rem_minmax(0,1fr)]">
          <nav className="flex gap-2 overflow-x-auto border-b p-3 md:flex-col md:border-r md:border-b-0">
            <SettingsTabButton
              active={activeTab === "accounts"}
              icon={<UserRound />}
              label="Accounts"
              onClick={() => onTabChange("accounts")}
            />
            <SettingsTabButton
              active={activeTab === "info"}
              icon={<Info />}
              label="Info"
              onClick={() => onTabChange("info")}
            />
          </nav>

          <ScrollArea className="h-[74vh]">
            <div className="p-5">
              {activeTab === "accounts" ? (
                <AccountManagementPanel
                  accounts={accounts}
                  accountRateLimitFetching={accountRateLimitFetching}
                  accountRateLimitSnapshots={accountRateLimitSnapshots}
                  accountUsageSummaries={accountUsageSummaries}
                  createFocusKey={createFocusKey}
                  session={session}
                />
              ) : null}
              {activeTab === "info" ? <ProjectInfoPanel /> : null}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SettingsTabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <Button
      aria-pressed={active}
      className={cn(
        "justify-start",
        active && "bg-muted text-foreground hover:bg-muted",
      )}
      variant="ghost"
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  )
}

function ProjectInfoPanel() {
  return (
    <div className="grid gap-4">
      <section className="rounded-md border bg-muted/30 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Info />
          Project
        </div>
        <div className="mt-2 text-sm text-muted-foreground">
          xedoc
        </div>
      </section>

      <section className="grid gap-3 rounded-md border bg-muted/30 p-4">
        <h3 className="text-sm font-semibold">Contact</h3>
        <a
          className="inline-flex w-fit items-center gap-2 text-sm text-primary underline-offset-4 hover:underline"
          href="https://github.com/monokaijs/xedoc"
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink className="size-4" />
          GitHub: monokaijs/xedoc
        </a>
        <a
          className="inline-flex w-fit items-center gap-2 text-sm text-primary underline-offset-4 hover:underline"
          href="mailto:monokaijs@gmail.com"
        >
          <Mail className="size-4" />
          Email: monokaijs@gmail.com
        </a>
      </section>
    </div>
  )
}
