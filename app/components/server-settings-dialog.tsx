import type { AccountResponse, CodexRateLimitSnapshot } from "@/types"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  Brain,
  ExternalLink,
  Info,
  Loader2,
  Mail,
  RefreshCw,
  Save,
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
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  getAccountPersonalization,
  updateAccountPersonalization,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import type { WebSession } from "@/lib/session-storage"

export type ServerSettingsTab = "accounts" | "personalization" | "info"

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
            Manage accounts, personalization, and project details.
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
              active={activeTab === "personalization"}
              icon={<Brain />}
              label="Personalization"
              onClick={() => onTabChange("personalization")}
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
              {activeTab === "personalization" ? (
                <PersonalizationPanel accounts={accounts} session={session} />
              ) : null}
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

function PersonalizationPanel({
  accounts,
  session,
}: {
  accounts: AccountResponse[]
  session: WebSession
}) {
  const [selectedAccountId, setSelectedAccountId] = useState(
    () => accounts[0]?.id ?? "",
  )
  const [draft, setDraft] = useState("")
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!accounts.length) {
      setSelectedAccountId("")
      return
    }
    if (!selectedAccountId || !accounts.some((entry) => entry.id === selectedAccountId)) {
      setSelectedAccountId(accounts[0].id)
    }
  }, [accounts, selectedAccountId])

  const selectedAccount = useMemo(
    () => accounts.find((entry) => entry.id === selectedAccountId),
    [accounts, selectedAccountId],
  )

  const personalizationQuery = useQuery({
    enabled: !!selectedAccountId,
    queryKey: ["account-personalization", selectedAccountId],
    queryFn: () => {
      if (!selectedAccountId) {
        throw new Error("Select an account.")
      }
      return getAccountPersonalization(session, selectedAccountId)
    },
  })

  useEffect(() => {
    if (personalizationQuery.data) {
      setDraft(personalizationQuery.data.instructions)
    }
  }, [personalizationQuery.data])

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!selectedAccountId) {
        throw new Error("Select an account.")
      }
      return updateAccountPersonalization(session, selectedAccountId, {
        instructions: draft,
      })
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (response) => {
      queryClient.setQueryData(
        ["account-personalization", response.accountId],
        response,
      )
      void queryClient.invalidateQueries({ queryKey: ["account-personalization"] })
      toast.success("Personalization saved.")
    },
  })

  const byteCount = useMemo(() => new TextEncoder().encode(draft).length, [draft])
  const maxBytes = personalizationQuery.data?.maxBytes ?? 32 * 1024
  const isDirty =
    !!personalizationQuery.data &&
    draft !== personalizationQuery.data.instructions
  const isTooLarge = byteCount > maxBytes

  if (!accounts.length) {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 p-6">
        <h3 className="text-sm font-semibold">No accounts</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Create an account before configuring personalization.
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center text-sm font-semibold">
            Custom instructions
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Saved to the shared Codex personalization file.
          </p>
        </div>
        <div
          className={cn(
            "text-xs text-muted-foreground",
            isTooLarge && "text-destructive",
          )}
        >
          {byteCount.toLocaleString()} / {maxBytes.toLocaleString()} bytes
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="personalization-instructions">
          AGENTS.md
        </Label>
        <Textarea
          className="min-h-72 font-mono text-xs leading-relaxed"
          disabled={personalizationQuery.isLoading || saveMutation.isPending}
          id="personalization-instructions"
          placeholder="## Working agreements&#10;&#10;- Prefer concise answers.&#10;- Run relevant tests after code changes."
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>

      {personalizationQuery.error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {readError(personalizationQuery.error)}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-muted-foreground">
            {personalizationQuery.data?.instructionsPath ??
              selectedAccount?.displayName ??
              "Personalization file"}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={personalizationQuery.isFetching}
            variant="outline"
            onClick={() => void personalizationQuery.refetch()}
          >
            {personalizationQuery.isFetching ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Reload
          </Button>
          <Button
            disabled={!isDirty || saveMutation.isPending}
            variant="secondary"
            onClick={() => setDraft(personalizationQuery.data?.instructions ?? "")}
          >
            <RefreshCw />
            Reset
          </Button>
          <Button
            disabled={
              !isDirty ||
              isTooLarge ||
              personalizationQuery.isLoading ||
              saveMutation.isPending
            }
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Save />
            )}
            Save
          </Button>
        </div>
      </div>
    </div>
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

function readError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Request failed."
}
