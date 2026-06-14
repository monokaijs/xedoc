import type { AccountResponse, CodexRateLimitSnapshot } from "@/types"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import {
  Download,
  ExternalLink,
  Info,
  Mail,
  RefreshCw,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"
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
import {
  getServerUpdateStatus,
  updateServerPackage,
} from "@/lib/api"
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
              {activeTab === "info" ? (
                <ProjectInfoPanel session={session} />
              ) : null}
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

function ProjectInfoPanel({ session }: { session: WebSession }) {
  const updateQuery = useQuery({
    queryKey: ["server-update-status"],
    queryFn: () => getServerUpdateStatus(session),
    refetchInterval: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    staleTime: 15 * 60 * 1000,
  })
  const updateMutation = useMutation({
    mutationFn: (force: boolean) => updateServerPackage(session, { force }),
    onError: (caught) => {
      toast.error(readSettingsError(caught))
    },
    onSuccess: (response) => {
      toast.success(response.message ?? "Update finished.")
      if (response.restartScheduled) {
        window.setTimeout(() => {
          window.location.reload()
        }, 4000)
        return
      }
      void updateQuery.refetch()
    },
  })
  const updateStatus = updateQuery.data
  const checking = updateQuery.isFetching
  const updating = updateMutation.isPending

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
        <div className="flex items-center gap-2 text-sm font-medium">
          <Download />
          Updates
        </div>
        <div className="grid gap-1 text-sm">
          <UpdateInfoRow
            label="Current"
            value={updateStatus?.currentVersion ?? "Unknown"}
          />
          <UpdateInfoRow
            label="Latest"
            value={
              checking && !updateStatus
                ? "Checking npm..."
                : updateStatus?.latestVersion ?? "Unavailable"
            }
          />
          <UpdateInfoRow
            label="Status"
            value={
              updateStatus?.updateAvailable
                ? "Update available"
                : updateStatus?.lastError
                  ? "Update check failed"
                  : updateStatus
                    ? "Up to date"
                    : "Not checked"
            }
          />
        </div>
        {updateStatus?.lastError ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            {updateStatus.lastError}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={checking || updating}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void updateQuery.refetch()}
          >
            <RefreshCw className={cn(checking && "animate-spin")} />
            Check now
          </Button>
          <Button
            disabled={!updateStatus?.updateAvailable || updating}
            size="sm"
            type="button"
            onClick={() => updateMutation.mutate(false)}
          >
            {updating ? <RefreshCw className="animate-spin" /> : <Download />}
            Update & restart
          </Button>
          <Button
            disabled={!updateStatus?.canUpdate || updating}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => updateMutation.mutate(true)}
          >
            Force update & restart
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          Uses npmjs via{" "}
          <span className="font-mono">
            {updateStatus?.installCommand ?? "npm install -g xedoc-cli@latest"}
          </span>
          , then restarts the local server automatically.
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

function UpdateInfoRow({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate">{value}</span>
    </div>
  )
}

function readSettingsError(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}
