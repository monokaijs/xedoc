import type {
  AccountAuthMode,
  AccountExportDocument,
  AccountImportEntry,
  AccountResponse,
  AuthenticateAccountResponse,
  CodexRateLimitSnapshot,
  LoginCallbackPortStatus,
  UpdateAccountRequest,
} from "@/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  CheckCircle2,
  CircleAlert,
  Download,
  ExternalLink,
  Import,
  KeyRound,
  Loader2,
  Plus,
  PowerOff,
  RotateCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { AccountCardEntry } from "@/components/account-card-entry"
import {
  authenticateAccount,
  cancelAccountAuthentication,
  completeAccountLogin,
  createAccount,
  deleteAccount,
  exportAccounts,
  importAccounts,
  importLocalCodexActiveAccount,
  killLoginCallbackPortProcess,
  readLoginCallbackPortStatus,
  setLocalCodexActiveAccount,
  updateAccount,
} from "@/lib/api"
import type { WebSession } from "@/lib/session-storage"
import {
  AuthenticationDialog,
  authenticationDialogEqual,
  authenticationDialogFromAccount,
  authenticationDialogFromResponse,
  normalizeAccountAuthMode,
  type AuthenticationDialogState,
} from "@/components/account-auth-dialog"

interface AccountFormState {
  args: string
  command: string
  displayName: string
  environment: string
}

interface CreateAccountMutationInput {
  authMode: AccountAuthMode
  popup?: Window | null
}

interface AuthenticateMutationInput {
  accountId: string
  mode?: AccountAuthMode
  popup?: Window | null
}

interface ImportAccountsMutationInput {
  accounts: AccountImportEntry[]
  popup?: Window | null
}

const emptyForm: AccountFormState = {
  args: "",
  command: "",
  displayName: "",
  environment: "",
}

export function AccountManagementPanel({
  accounts,
  accountRateLimitFetching,
  accountRateLimitSnapshots,
  accountUsageSummaries,
  createFocusKey = 0,
  session,
}: {
  accounts: AccountResponse[]
  accountRateLimitFetching: Record<string, boolean>
  accountRateLimitSnapshots: Record<string, CodexRateLimitSnapshot>
  accountUsageSummaries: Record<string, string>
  createFocusKey?: number
  session: WebSession
}) {
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [authDialog, setAuthDialog] =
    useState<AuthenticationDialogState | null>(null)
  const [callbackUrl, setCallbackUrl] = useState("")
  const [accountSearch, setAccountSearch] = useState("")
  const [editingAccount, setEditingAccount] = useState<AccountResponse | null>(
    null,
  )
  const [editForm, setEditForm] = useState<AccountFormState>(emptyForm)
  const [deleteTarget, setDeleteTarget] = useState<AccountResponse | null>(null)
  const authPopupRef = useRef<Window | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const queryClient = useQueryClient()
  const callbackPortQueryKey = useMemo(
    () => ["login-callback-port", session.serverUrl] as const,
    [session.serverUrl],
  )

  const callbackPortQuery = useQuery({
    queryKey: callbackPortQueryKey,
    queryFn: () => readLoginCallbackPortStatus(session),
    refetchInterval: (query) => (query.state.data?.inUse ? 5_000 : 15_000),
    retry: 1,
    staleTime: 3_000,
  })

  useEffect(() => {
    if (createFocusKey <= 0) {
      return
    }

    const timeout = window.setTimeout(() => {
      setAddMenuOpen(true)
    }, 80)

    return () => window.clearTimeout(timeout)
  }, [createFocusKey])

  useEffect(() => {
    setAuthDialog((current) => {
      if (!current?.accountId) {
        return current
      }
      const account = accounts.find((entry) => entry.id === current.accountId)
      if (!account) {
        return current
      }
      const nextMode =
        normalizeAccountAuthMode(account.lastAuthMode) ?? current.mode
      const nextAuthUrl =
        account.status === "AUTHENTICATING"
          ? (account.lastAuthUrl ?? current.authUrl)
          : account.lastAuthUrl
      const nextUserCode =
        account.status === "AUTHENTICATING"
          ? (account.lastAuthUserCode ?? current.userCode)
          : account.lastAuthUserCode
      const next = {
        ...current,
        accountName: account.displayName,
        authUrl: nextAuthUrl ?? null,
        mode: nextMode,
        status: account.status,
        userCode: nextUserCode ?? null,
      }
      return authenticationDialogEqual(current, next) ? current : next
    })
  }, [accounts])

  useEffect(() => {
    if (!authDialog?.accountId || authDialog.status === "CONNECTED") {
      return
    }
    const account = accounts.find((entry) => entry.id === authDialog.accountId)
    if (account?.status !== "CONNECTED") {
      return
    }
    closeAuthPopup()
    setAuthDialog(null)
    setCallbackUrl("")
    toast.success("Account connected.")
  }, [accounts, authDialog?.accountId, authDialog?.status])

  const invalidateAccounts = () =>
    queryClient.invalidateQueries({ queryKey: ["accounts"] })

  const filteredAccounts = useMemo(
    () => filterAccounts(accounts, accountSearch),
    [accounts, accountSearch],
  )
  const browserAuthenticationInProgress = useMemo(
    () =>
      accounts.some(
        (account) =>
          account.status === "AUTHENTICATING" &&
          normalizeAccountAuthMode(account.lastAuthMode) !== "device",
      ),
    [accounts],
  )

  const createMutation = useMutation({
    mutationFn: async (input: CreateAccountMutationInput) => {
      const account = await createAccount(session, {})
      const auth = await authenticateAccount(session, account.id, {
        mode: input.authMode,
      })
      return { account, auth, popup: input.popup }
    },
    onError: (caught, variables) => {
      closeAuthPopup(variables?.popup ?? null)
      setAuthDialog((current) =>
        current
          ? { ...current, message: readError(caught), status: "ERROR" }
          : current,
      )
      toast.error(readError(caught))
    },
    onSuccess: ({ account, auth, popup }) => {
      void invalidateAccounts()
      handleAuthenticationResponse(auth, popup, account)
    },
  })

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!editingAccount) {
        throw new Error("Select an account to edit.")
      }
      return updateAccount(session, editingAccount.id, {
        ...buildAccountPayload(editForm),
        displayName: editForm.displayName.trim(),
      } satisfies UpdateAccountRequest)
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: () => {
      setEditingAccount(null)
      setEditForm(emptyForm)
      toast.success("Account updated.")
      void invalidateAccounts()
    },
  })

  const authMutation = useMutation({
    mutationFn: ({ accountId, mode }: AuthenticateMutationInput) =>
      authenticateAccount(session, accountId, { mode }),
    onError: (caught, variables) => {
      closeAuthPopup(variables?.popup ?? null)
      setAuthDialog((current) =>
        current
          ? { ...current, message: readError(caught), status: "ERROR" }
          : current,
      )
      toast.error(readError(caught))
    },
    onSuccess: (response, variables) => {
      void invalidateAccounts()
      const account = accounts.find((entry) => entry.id === variables.accountId)
      handleAuthenticationResponse(response, variables.popup, account)
    },
  })

  const cancelAuthMutation = useMutation({
    mutationFn: (accountId: string) =>
      cancelAccountAuthentication(session, accountId),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (account) => {
      closeAuthPopup()
      setAuthDialog(null)
      setCallbackUrl("")
      toast.success(`Canceled authentication for ${account.displayName}.`)
      void invalidateAccounts()
    },
  })

  const completeLoginMutation = useMutation({
    mutationFn: ({
      accountId,
      redirectUrl,
    }: {
      accountId: string
      redirectUrl: string
    }) =>
      completeAccountLogin(session, accountId, {
        redirectUrl: redirectUrl.trim(),
      }),
    onError: (caught) => {
      setAuthDialog((current) =>
        current
          ? { ...current, message: readError(caught), status: "ERROR" }
          : current,
      )
      toast.error(readError(caught))
    },
    onSuccess: (response) => {
      setCallbackUrl("")
      void invalidateAccounts()
      handleAuthenticationResponse(response)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (accountId: string) => deleteAccount(session, accountId),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: () => {
      setDeleteTarget(null)
      toast.success("Account deleted.")
      void invalidateAccounts()
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const exportMutation = useMutation({
    mutationFn: () => exportAccounts(session),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (document) => {
      downloadAccountsExport(document)
      toast.success(
        `Exported ${document.accounts.length} ${accountLabel(document.accounts.length)}. Keep the file private; it may include Codex auth tokens.`,
      )
    },
  })

  const killCallbackPortMutation = useMutation({
    mutationFn: () => killLoginCallbackPortProcess(session),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (status) => {
      queryClient.setQueryData(callbackPortQueryKey, status)
      if (status.inUse) {
        toast.warning(
          `${status.host}:${status.port} is still in use. The process may need more time to exit.`,
        )
        return
      }
      toast.success(formatKilledCallbackPortProcesses(status))
    },
  })

  const importMutation = useMutation({
    mutationFn: (input: ImportAccountsMutationInput) =>
      importAccounts(session, {
        accounts: input.accounts,
      }),
    onError: (caught, variables) => {
      variables?.popup?.close()
      toast.error(readError(caught))
    },
    onSuccess: (response, variables) => {
      toast.success(
        `Imported ${response.imported} ${accountLabel(response.imported)}.`,
      )
      void invalidateAccounts()
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      handleImportAuthenticationResponses(
        response.authentications,
        variables.popup,
      )
    },
  })

  const localImportMutation = useMutation({
    mutationFn: () => importLocalCodexActiveAccount(session),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (response) => {
      toast.success(
        `Imported ${response.imported} local ${accountLabel(response.imported)}.`,
      )
      void invalidateAccounts()
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const setLocalActiveMutation = useMutation({
    mutationFn: (accountId: string) =>
      setLocalCodexActiveAccount(session, accountId),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (account) => {
      toast.success(`${account.displayName} is now active in local Codex.`)
      void invalidateAccounts()
    },
  })

  function startEditing(account: AccountResponse) {
    setEditingAccount(account)
    setEditForm({
      args: account.args.join(" "),
      command: account.command,
      displayName: account.displayName,
      environment: formatEnvironment(account.environment),
    })
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file) {
      return
    }

    const popup = openPreparedAuthWindow()
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      importMutation.mutate({ accounts: readImportAccounts(parsed), popup })
    } catch (caught) {
      popup?.close()
      toast.error(readError(caught))
    }
  }

  async function ensureBrowserCallbackPortAvailable(): Promise<boolean> {
    const status = callbackPortQuery.data?.inUse
      ? callbackPortQuery.data
      : (await callbackPortQuery.refetch()).data

    if (!status?.inUse) {
      return true
    }

    toast.error(
      `${status.host}:${status.port} is already in use. Kill the process or use Device Auth.`,
    )
    return false
  }

  async function startAuthentication(
    accountId: string,
    mode: AccountAuthMode = "browser",
  ) {
    if (mode === "browser" && !(await ensureBrowserCallbackPortAvailable())) {
      return
    }

    const account = accounts.find((entry) => entry.id === accountId)
    const popup = openPreparedAuthWindow()
    authPopupRef.current = popup
    setCallbackUrl("")
    setAuthDialog(authenticationDialogFromAccount(account, mode))
    authMutation.mutate({
      accountId,
      mode,
      popup,
    })
  }

  async function createAndAuthenticate(authMode: AccountAuthMode) {
    if (
      authMode === "browser" &&
      !(await ensureBrowserCallbackPortAvailable())
    ) {
      setAddMenuOpen(false)
      return
    }

    const popup = openPreparedAuthWindow()
    authPopupRef.current = popup
    setAddMenuOpen(false)
    setCallbackUrl("")
    setAuthDialog({
      accountId: "",
      accountName: "Codex account",
      authUrl: null,
      message: "Creating account and starting Codex authentication.",
      mode: authMode,
      status: "AUTHENTICATING",
      userCode: null,
    })
    createMutation.mutate({
      authMode,
      popup,
    })
  }

  function showAuthenticationDialogForAccount(account: AccountResponse) {
    setCallbackUrl("")
    setAuthDialog(
      authenticationDialogFromAccount(
        account,
        normalizeAccountAuthMode(account.lastAuthMode) ?? "browser",
      ),
    )
  }

  function handleAuthenticationResponse(
    response: AuthenticateAccountResponse,
    popup?: Window | null,
    account?: AccountResponse,
  ) {
    setAuthDialog(authenticationDialogFromResponse(response, account))
    if (response.authUrl) {
      authPopupRef.current = popup ?? authPopupRef.current
      openAuthUrl(response.authUrl, popup)
      toast.info(
        response.authMode === "device"
          ? "Device login page opened."
          : "Authentication page opened. xedoc is listening for the Codex callback.",
      )
      return
    }

    closeAuthPopup(popup)
    if (response.status === "AUTHENTICATING") {
      toast.info(response.message ?? "Authentication is still in progress.")
      return
    }
    toast.success(response.message ?? "Account is connected.")
  }

  function handleImportAuthenticationResponses(
    responses: AuthenticateAccountResponse[],
    popup?: Window | null,
  ) {
    const firstWithAuthUrl = responses.find((response) => response.authUrl)
    if (firstWithAuthUrl) {
      handleAuthenticationResponse(firstWithAuthUrl, popup)
      const remainingAuthUrls = responses.filter(
        (response) => response.authUrl && response !== firstWithAuthUrl,
      ).length
      if (remainingAuthUrls) {
        toast.info(
          `${remainingAuthUrls} more ${accountLabel(remainingAuthUrls)} need authentication.`,
        )
      }
      return
    }

    popup?.close()
    const connectedCount = responses.filter(
      (response) => response.status === "CONNECTED",
    ).length
    if (connectedCount) {
      toast.success(
        `Connected ${connectedCount} imported ${accountLabel(connectedCount)}.`,
      )
    }
  }

  function closeAuthPopup(popup: Window | null = authPopupRef.current) {
    if (popup && !popup.closed) {
      popup.close()
    }
    if (!popup || popup === authPopupRef.current) {
      authPopupRef.current = null
    }
  }

  return (
    <>
      <div className="grid gap-5">
        <section className="grid gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Accounts</h3>
              <p className="text-sm text-muted-foreground">
                Search, authenticate, and inspect current Codex quota.
              </p>
            </div>
          </div>

          <LoginCallbackPortWarning
            browserAuthenticationInProgress={browserAuthenticationInProgress}
            checking={callbackPortQuery.isFetching}
            killing={killCallbackPortMutation.isPending}
            status={callbackPortQuery.data}
            onKill={() => killCallbackPortMutation.mutate()}
            onRefresh={() => void callbackPortQuery.refetch()}
          />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 flex-1 sm:min-w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search accounts"
                value={accountSearch}
                onChange={(event) => setAccountSearch(event.target.value)}
              />
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
              <input
                ref={importInputRef}
                accept="application/json,.json"
                className="hidden"
                type="file"
                onChange={handleImportFile}
              />
              <Button
                className="w-full sm:w-auto"
                disabled={importMutation.isPending}
                variant="outline"
                onClick={() => importInputRef.current?.click()}
              >
                {importMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Upload />
                )}
                Import
              </Button>
              <Button
                className="w-full sm:w-auto"
                disabled={exportMutation.isPending}
                variant="outline"
                onClick={() => exportMutation.mutate()}
              >
                {exportMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )}
                Export
              </Button>
              <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
                <DropdownMenuTrigger
                  render={<Button className="w-full sm:w-auto" />}
                >
                  {createMutation.isPending || localImportMutation.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Plus />
                  )}
                  Add
                  <ChevronDown data-icon="inline-end" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    disabled={createMutation.isPending}
                    onClick={() => createAndAuthenticate("browser")}
                  >
                    <ExternalLink />
                    Normal Auth
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={createMutation.isPending}
                    onClick={() => createAndAuthenticate("device")}
                  >
                    <KeyRound />
                    Device Auth
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={localImportMutation.isPending}
                    onClick={() => {
                      setAddMenuOpen(false)
                      localImportMutation.mutate()
                    }}
                  >
                    {localImportMutation.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Import />
                    )}
                    Import Local
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="grid gap-2">
            {filteredAccounts.length ? (
              filteredAccounts.map((account) => (
                <AccountCardEntry
                  account={account}
                  authPending={
                    authMutation.isPending &&
                    authMutation.variables?.accountId === account.id
                  }
                  authPendingMode={authMutation.variables?.mode ?? "browser"}
                  cancelPending={
                    cancelAuthMutation.isPending &&
                    cancelAuthMutation.variables === account.id
                  }
                  key={account.id}
                  localActivePending={
                    setLocalActiveMutation.isPending &&
                    setLocalActiveMutation.variables === account.id
                  }
                  quotaLabel={accountUsageSummaries[account.id]}
                  quotaPending={!!accountRateLimitFetching[account.id]}
                  quotaSnapshot={accountRateLimitSnapshots[account.id]}
                  onDelete={() => setDeleteTarget(account)}
                  onEdit={() => startEditing(account)}
                  onAuthenticate={(mode) =>
                    startAuthentication(account.id, mode)
                  }
                  onCancelAuthentication={() =>
                    cancelAuthMutation.mutate(account.id)
                  }
                  onSetLocalActive={() =>
                    setLocalActiveMutation.mutate(account.id)
                  }
                  onShowAuthentication={() =>
                    showAuthenticationDialogForAccount(account)
                  }
                />
              ))
            ) : (
              <div className="rounded-md border bg-background px-3 py-8 text-center text-sm text-muted-foreground">
                {accounts.length
                  ? "No accounts match the current search."
                  : "No accounts yet. Add an account or import account records."}
              </div>
            )}
          </div>
        </section>
      </div>

      <AuthenticationDialog
        callbackUrl={callbackUrl}
        cancelPending={
          cancelAuthMutation.isPending &&
          cancelAuthMutation.variables === authDialog?.accountId
        }
        completePending={completeLoginMutation.isPending}
        state={authDialog}
        onCallbackUrlChange={setCallbackUrl}
        onClose={() => {
          setAuthDialog(null)
          setCallbackUrl("")
        }}
        onCancelAuthentication={() => {
          if (authDialog?.accountId) {
            cancelAuthMutation.mutate(authDialog.accountId)
          }
        }}
        onComplete={() => {
          if (authDialog?.accountId) {
            completeLoginMutation.mutate({
              accountId: authDialog.accountId,
              redirectUrl: callbackUrl,
            })
          }
        }}
        onCopyDeviceCode={() => void copyDeviceCode(authDialog?.userCode ?? "")}
        onReopen={() => openAuthUrl(authDialog?.authUrl)}
      />

      <Dialog
        open={!!editingAccount}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !updateMutation.isPending) {
            setEditingAccount(null)
            setEditForm(emptyForm)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Edit {editingAccount?.displayName ?? "account"}
            </DialogTitle>
            <DialogDescription>
              Saving runtime settings disconnects the account until it is
              authenticated again.
            </DialogDescription>
          </DialogHeader>
          <AccountForm
            form={editForm}
            onChange={setEditForm}
            prefix={`edit-account-${editingAccount?.id ?? "selected"}`}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditingAccount(null)
                setEditForm(emptyForm)
              }}
            >
              <X />
              Cancel
            </Button>
            <Button
              disabled={
                !editForm.displayName.trim() || updateMutation.isPending
              }
              onClick={() => updateMutation.mutate()}
            >
              {updateMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <CheckCircle2 />
              )}
              Save account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setDeleteTarget(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {deleteTarget?.displayName ?? "the account"} from
              xedoc. Chats that reference it may no longer run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  deleteMutation.mutate(deleteTarget.id)
                }
              }}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AccountForm({
  form,
  onChange,
  prefix,
}: {
  form: AccountFormState
  onChange: (form: AccountFormState) => void
  prefix: string
}) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <Label htmlFor={`${prefix}-name`}>Display name</Label>
        <Input
          id={`${prefix}-name`}
          placeholder="Work Codex"
          value={form.displayName}
          onChange={(event) =>
            onChange({ ...form, displayName: event.target.value })
          }
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${prefix}-command`}>Command</Label>
          <Input
            id={`${prefix}-command`}
            placeholder="codex"
            value={form.command}
            onChange={(event) =>
              onChange({ ...form, command: event.target.value })
            }
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${prefix}-args`}>Arguments</Label>
          <Input
            id={`${prefix}-args`}
            placeholder="app-server"
            value={form.args}
            onChange={(event) =>
              onChange({ ...form, args: event.target.value })
            }
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${prefix}-environment`}>Environment JSON</Label>
        <Textarea
          className="min-h-20 font-mono text-xs"
          id={`${prefix}-environment`}
          placeholder='{"OPENAI_BASE_URL":"https://..."}'
          value={form.environment}
          onChange={(event) =>
            onChange({ ...form, environment: event.target.value })
          }
        />
      </div>
    </div>
  )
}

function LoginCallbackPortWarning({
  browserAuthenticationInProgress,
  checking,
  killing,
  status,
  onKill,
  onRefresh,
}: {
  browserAuthenticationInProgress: boolean
  checking: boolean
  killing: boolean
  status?: LoginCallbackPortStatus
  onKill: () => void
  onRefresh: () => void
}) {
  if (!status?.inUse) {
    return null
  }

  const processLabel = formatCallbackPortProcesses(status)
  const killLabel =
    status.processes.length === 1 ? "Kill Process" : "Kill Processes"

  return (
    <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/35 dark:text-amber-100 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="grid min-w-0 gap-1">
          <div className="text-sm font-medium">Login callback port is busy</div>
          <p className="text-sm leading-relaxed">
            {browserAuthenticationInProgress
              ? `${status.host}:${status.port} is already listening for a browser login. Starting another Normal Auth can fail while this listener is active.`
              : `${status.host}:${status.port} is already listening. Normal Auth can fail until this process is stopped.`}
          </p>
          <p className="break-words text-xs text-amber-800 dark:text-amber-200/80">
            {processLabel ?? "Process details are unavailable."}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
        <Button
          disabled={checking || killing}
          size="sm"
          variant="outline"
          onClick={onRefresh}
        >
          {checking ? <Loader2 className="animate-spin" /> : <RotateCw />}
          Refresh
        </Button>
        <Button
          disabled={!status.killable || killing}
          size="sm"
          variant="destructive"
          onClick={onKill}
        >
          {killing ? <Loader2 className="animate-spin" /> : <PowerOff />}
          {killLabel}
        </Button>
      </div>
    </div>
  )
}

function buildAccountPayload(form: AccountFormState) {
  const payload: {
    args?: string[]
    command?: string
    environment?: Record<string, string>
  } = {}

  if (form.command.trim()) {
    payload.command = form.command.trim()
  }

  if (form.args.trim()) {
    payload.args = form.args
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  if (form.environment.trim()) {
    const parsed = JSON.parse(form.environment) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Environment must be a JSON object.")
    }
    payload.environment = parsed as Record<string, string>
  }

  return payload
}

function readImportAccounts(value: unknown): AccountImportEntry[] {
  if (Array.isArray(value)) {
    return value as AccountImportEntry[]
  }
  if (value && typeof value === "object") {
    const accounts = (value as { accounts?: unknown }).accounts
    if (Array.isArray(accounts)) {
      return accounts as AccountImportEntry[]
    }
  }
  throw new Error("Import file must contain an accounts array.")
}

function downloadAccountsExport(document: AccountExportDocument) {
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
    type: "application/json",
  })
  const url = URL.createObjectURL(blob)
  const link = window.document.createElement("a")
  link.href = url
  link.download = `xedoc-accounts-${new Date().toISOString().slice(0, 10)}.json`
  window.document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function formatEnvironment(
  environment: AccountResponse["environment"],
): string {
  return environment ? JSON.stringify(environment, null, 2) : ""
}

function filterAccounts(
  accounts: AccountResponse[],
  search: string,
): AccountResponse[] {
  const normalized = search.trim().toLocaleLowerCase()
  if (!normalized) {
    return accounts
  }

  return accounts.filter((account) =>
    [
      account.displayName,
      account.status,
      account.command,
      account.args.join(" "),
      account.defaultModel,
      account.defaultPermissionMode,
      account.defaultReasoningEffort,
      account.defaultServiceTier,
      account.lastError,
      account.environment ? JSON.stringify(account.environment) : null,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(normalized)),
  )
}

function accountLabel(count: number): string {
  return count === 1 ? "account" : "accounts"
}

async function copyDeviceCode(code: string) {
  if (!code) {
    return
  }
  try {
    await navigator.clipboard.writeText(code)
    toast.success("Device code copied.")
  } catch {
    toast.error("Could not copy device code.")
  }
}

function formatCallbackPortProcesses(
  status: LoginCallbackPortStatus,
): string | null {
  if (!status.processes.length) {
    return null
  }

  return status.processes
    .map((entry) =>
      [
        entry.command ?? "process",
        `PID ${entry.pid}`,
        entry.user ? `user ${entry.user}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(", ")
}

function formatKilledCallbackPortProcesses(
  status: LoginCallbackPortStatus,
): string {
  const processIds = status.killedProcessIds ?? []
  if (!processIds.length) {
    return "Login callback port is available."
  }
  return `Killed ${processIds.length === 1 ? "process" : "processes"} ${processIds.join(", ")}.`
}

function readError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Request failed."
}

function openPreparedAuthWindow(): Window | null {
  const popup = window.open("about:blank", "_blank")
  if (popup) {
    popup.opener = null
  }
  return popup
}

function openAuthUrl(url?: string | null, popup?: Window | null) {
  if (!url) {
    popup?.close()
    return
  }

  if (popup && !popup.closed) {
    popup.location.href = url
    return
  }

  window.open(url, "_blank", "noopener,noreferrer")
}
