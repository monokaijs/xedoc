import type {
  AccountAuthMode,
  AccountExportDocument,
  AccountImportEntry,
  AccountResponse,
  UpdateAccountRequest,
} from "@/types"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { useEffect, useRef, useState, type ChangeEvent, type Ref } from "react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { StatusBadge } from "@/components/status-badge"
import {
  authenticateAccount,
  completeAccountLogin,
  createAccount,
  deleteAccount,
  exportAccounts,
  importAccounts,
  updateAccount,
} from "@/lib/api"
import type { WebSession } from "@/lib/session-storage"

interface AccountFormState {
  args: string
  command: string
  displayName: string
  environment: string
}

interface CreateAccountMutationInput {
  authMode?: AccountAuthMode
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
  createFocusKey = 0,
  session,
}: {
  accounts: AccountResponse[]
  createFocusKey?: number
  session: WebSession
}) {
  const [createForm, setCreateForm] = useState<AccountFormState>(emptyForm)
  const [editingAccount, setEditingAccount] = useState<AccountResponse | null>(
    null,
  )
  const [editForm, setEditForm] = useState<AccountFormState>(emptyForm)
  const [callbackUrls, setCallbackUrls] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<AccountResponse | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const createSectionRef = useRef<HTMLElement | null>(null)
  const createNameInputRef = useRef<HTMLInputElement | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (createFocusKey <= 0) {
      return
    }

    const timeout = window.setTimeout(() => {
      createSectionRef.current?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      })
      createNameInputRef.current?.focus()
    }, 80)

    return () => window.clearTimeout(timeout)
  }, [createFocusKey])

  const invalidateAccounts = () =>
    queryClient.invalidateQueries({ queryKey: ["accounts"] })

  const createMutation = useMutation({
    mutationFn: async (input: CreateAccountMutationInput = {}) => {
      const account = await createAccount(session, {
        ...buildAccountPayload(createForm),
        displayName: createForm.displayName.trim(),
      })
      if (!input.authMode) {
        return { account, auth: null, popup: input.popup }
      }
      const auth = await authenticateAccount(session, account.id, {
        mode: input.authMode,
      })
      return { account, auth, popup: input.popup }
    },
    onError: (caught, variables) => {
      variables?.popup?.close()
      toast.error(readError(caught))
    },
    onSuccess: ({ auth, popup }) => {
      setCreateForm(emptyForm)
      toast.success("Account created.")
      void invalidateAccounts()
      if (auth) {
        handleAuthenticationResponse(auth, popup)
      }
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
      variables?.popup?.close()
      toast.error(readError(caught))
    },
    onSuccess: (response, variables) => {
      void invalidateAccounts()
      handleAuthenticationResponse(response, variables.popup)
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
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (response, variables) => {
      setCallbackUrls((current) => ({ ...current, [variables.accountId]: "" }))
      void invalidateAccounts()
      if (response.status === "CONNECTED") {
        toast.success("Account connected.")
        return
      }
      toast.info(response.message ?? "Callback accepted.")
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
        `Exported ${document.accounts.length} ${accountLabel(document.accounts.length)}.`,
      )
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

  function startAuthentication(accountId: string, mode: AccountAuthMode = "browser") {
    authMutation.mutate({
      accountId,
      mode,
      popup: openPreparedAuthWindow(),
    })
  }

  function createAndAuthenticate(authMode: AccountAuthMode) {
    createMutation.mutate({
      authMode,
      popup: openPreparedAuthWindow(),
    })
  }

  function handleAuthenticationResponse(
    response: {
      authMode?: AccountAuthMode | null
      authUrl?: string | null
      message?: string
      status?: string
    },
    popup?: Window | null,
  ) {
    if (response.authUrl) {
      openAuthUrl(response.authUrl, popup)
      toast.info(
        response.authMode === "device"
          ? "Device login page opened."
          : "Authentication page opened.",
      )
      return
    }

    popup?.close()
    if (response.status === "AUTHENTICATING") {
      toast.info(response.message ?? "Authentication is still in progress.")
      return
    }
    toast.success(response.message ?? "Account is connected.")
  }

  function handleImportAuthenticationResponses(
    responses: Array<{
      authMode?: AccountAuthMode | null
      authUrl?: string | null
      message?: string
      status?: string
    }>,
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

  return (
    <>
      <div className="grid gap-5">
              <section className="grid gap-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">Accounts</h3>
                    <p className="text-sm text-muted-foreground">
                      Authenticate accounts before using them for chats.
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {accounts.length} {accountLabel(accounts.length)}
                  </div>
                </div>
                {accounts.length ? (
                  accounts.map((account) => {
                    const callbackUrl = callbackUrls[account.id] ?? ""
                    const pendingAccountAuthMode =
                      normalizeAccountAuthMode(account.lastAuthMode) ?? "browser"
                    const isDeviceAuth = pendingAccountAuthMode === "device"
                    const showCallbackInput =
                      account.status === "AUTHENTICATING" || !!account.lastAuthUrl
                    const accountAuthPending =
                      authMutation.isPending &&
                      authMutation.variables?.accountId === account.id
                    const pendingMutationAuthMode =
                      authMutation.variables?.mode ?? "browser"
                    const browserAuthPending =
                      accountAuthPending && pendingMutationAuthMode === "browser"
                    const deviceAuthPending =
                      accountAuthPending && pendingMutationAuthMode === "device"
                    const completePending =
                      completeLoginMutation.isPending &&
                      completeLoginMutation.variables?.accountId === account.id

                    return (
                      <div
                        className="grid gap-4 rounded-md border bg-background p-4"
                        key={account.id}
                      >
                        {editingAccount?.id === account.id ? (
                          <>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h4 className="text-sm font-semibold">
                                  Edit {account.displayName}
                                </h4>
                                <p className="text-xs text-muted-foreground">
                                  Saving runtime settings disconnects the account
                                  until it is authenticated again.
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingAccount(null)
                                  setEditForm(emptyForm)
                                }}
                              >
                                <X />
                                Cancel
                              </Button>
                            </div>
                            <AccountForm
                              form={editForm}
                              onChange={setEditForm}
                              prefix={`edit-account-${account.id}`}
                            />
                            <Button
                              className="w-fit"
                              disabled={
                                !editForm.displayName.trim() ||
                                updateMutation.isPending
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
                          </>
                        ) : (
                          <>
                            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                              <div className="min-w-0 space-y-2">
                                <div className="flex items-center gap-2">
                                  <h4 className="truncate text-sm font-semibold">
                                    {account.displayName}
                                  </h4>
                                  <StatusBadge status={account.status} />
                                </div>
                                <p className="truncate font-mono text-xs text-muted-foreground">
                                  {account.command} {account.args.join(" ")}
                                </p>
                                {account.environment ? (
                                  <p className="text-xs text-muted-foreground">
                                    {Object.keys(account.environment).length} env{" "}
                                    {Object.keys(account.environment).length === 1
                                      ? "value"
                                      : "values"}
                                  </p>
                                ) : null}
                                {account.lastError ? (
                                  <p className="mt-2 whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                                    {account.lastError}
                                  </p>
                                ) : null}
                              </div>
                              <div className="flex flex-wrap justify-start gap-2 md:justify-end">
                                <Button
                                  disabled={accountAuthPending}
                                  size="sm"
                                  variant={
                                    account.status === "CONNECTED"
                                      ? "secondary"
                                      : "default"
                                  }
                                  onClick={() =>
                                    startAuthentication(
                                      account.id,
                                      account.status === "AUTHENTICATING"
                                        ? pendingAccountAuthMode
                                        : "browser",
                                    )
                                  }
                                >
                                  {browserAuthPending ? (
                                    <Loader2 className="animate-spin" />
                                  ) : account.status === "AUTHENTICATING" ? (
                                    <RotateCw />
                                  ) : (
                                    <ExternalLink />
                                  )}
                                  {account.status === "AUTHENTICATING"
                                    ? "Check"
                                    : account.status === "CONNECTED"
                                      ? "Re-authenticate"
                                      : "Authenticate"}
                                </Button>
                                <Button
                                  disabled={accountAuthPending}
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    startAuthentication(account.id, "device")
                                  }
                                >
                                  {deviceAuthPending ? (
                                    <Loader2 className="animate-spin" />
                                  ) : (
                                    <KeyRound />
                                  )}
                                  Device Login
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => startEditing(account)}
                                >
                                  <Pencil />
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => setDeleteTarget(account)}
                                >
                                  <Trash2 />
                                  Delete
                                </Button>
                              </div>
                            </div>

                            {showCallbackInput ? (
                              <div className="grid gap-4 rounded-md border bg-muted/25 p-3">
                                <div>
                                  <h5 className="text-sm font-medium">
                                    {isDeviceAuth
                                      ? "Device Login"
                                      : "Authentication"}
                                  </h5>
                                  <p className="text-xs text-muted-foreground">
                                    {isDeviceAuth
                                      ? "Open the verification URL and enter the device code."
                                      : "Open the auth URL, finish login, then paste the localhost callback response URL."}
                                  </p>
                                </div>
                                {account.lastAuthUrl ? (
                                  <div className="grid gap-2">
                                    <Label htmlFor={`auth-url-${account.id}`}>
                                      {isDeviceAuth
                                        ? "Verification URL"
                                        : "Auth URL"}
                                    </Label>
                                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                                      <Input
                                        className="font-mono text-xs"
                                        id={`auth-url-${account.id}`}
                                        readOnly
                                        value={account.lastAuthUrl}
                                      />
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          openAuthUrl(account.lastAuthUrl ?? null)
                                        }
                                      >
                                        <ExternalLink />
                                        Open
                                      </Button>
                                    </div>
                                  </div>
                                ) : null}
                                {isDeviceAuth ? (
                                  account.lastAuthUserCode ? (
                                    <div className="grid gap-2">
                                      <Label
                                        htmlFor={`device-code-${account.id}`}
                                      >
                                        Device code
                                      </Label>
                                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                                        <Input
                                          className="font-mono text-sm tracking-wider"
                                          id={`device-code-${account.id}`}
                                          readOnly
                                          value={account.lastAuthUserCode}
                                        />
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() =>
                                            copyDeviceCode(
                                              account.lastAuthUserCode ?? "",
                                            )
                                          }
                                        >
                                          <Copy />
                                          Copy
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="rounded-md border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">
                                      Start device login again to get a fresh
                                      code.
                                    </p>
                                  )
                                ) : (
                                  <>
                                    <div className="grid gap-2">
                                      <Label
                                        htmlFor={`callback-url-${account.id}`}
                                      >
                                        Callback response URL
                                      </Label>
                                      <Textarea
                                        className="min-h-20 font-mono text-xs"
                                        id={`callback-url-${account.id}`}
                                        placeholder="http://localhost:1455/..."
                                        value={callbackUrl}
                                        onChange={(event) =>
                                          setCallbackUrls((current) => ({
                                            ...current,
                                            [account.id]: event.target.value,
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="flex justify-end">
                                      <Button
                                        disabled={
                                          !callbackUrl.trim() || completePending
                                        }
                                        onClick={() =>
                                          completeLoginMutation.mutate({
                                            accountId: account.id,
                                            redirectUrl: callbackUrl,
                                          })
                                        }
                                      >
                                        {completePending ? (
                                          <Loader2 className="animate-spin" />
                                        ) : (
                                          <CheckCircle2 />
                                        )}
                                        Complete Login
                                      </Button>
                                    </div>
                                  </>
                                )}
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    )
                  })
                ) : (
                  <div className="rounded-md border border-dashed bg-muted/20 p-6">
                    <h4 className="text-sm font-semibold">No accounts</h4>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Create an account below or import account records from a
                      JSON export.
                    </p>
                  </div>
                )}
              </section>

              <section
                className="grid gap-3 rounded-md border bg-muted/30 p-4"
                ref={createSectionRef}
              >
                <div>
                  <h3 className="text-sm font-semibold">Create account</h3>
                  <p className="text-sm text-muted-foreground">
                    Use a readable name. Runtime fields are optional.
                  </p>
                </div>
                <AccountForm
                  displayNameRef={createNameInputRef}
                  form={createForm}
                  onChange={setCreateForm}
                  prefix="create-account"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={
                      !createForm.displayName.trim() || createMutation.isPending
                    }
                    onClick={() => createAndAuthenticate("browser")}
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <ExternalLink />
                    )}
                    Create & Authenticate
                  </Button>
                  <Button
                    disabled={
                      !createForm.displayName.trim() || createMutation.isPending
                    }
                    variant="secondary"
                    onClick={() => createAndAuthenticate("device")}
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <KeyRound />
                    )}
                    Create & Device Login
                  </Button>
                  <Button
                    disabled={
                      !createForm.displayName.trim() || createMutation.isPending
                    }
                    variant="outline"
                    onClick={() => createMutation.mutate({})}
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Plus />
                    )}
                    Create Only
                  </Button>
                </div>
              </section>

              <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">Import / export</h3>
                  <p className="text-sm text-muted-foreground">
                    Move account records and runtime settings with JSON. Codex
                    auth tokens stay on this server.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={importInputRef}
                    accept="application/json,.json"
                    className="hidden"
                    type="file"
                    onChange={handleImportFile}
                  />
                  <Button
                    disabled={importMutation.isPending}
                    variant="secondary"
                    onClick={() => importInputRef.current?.click()}
                  >
                    {importMutation.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Upload />
                    )}
                    Import JSON
                  </Button>
                  <Button
                    disabled={exportMutation.isPending}
                    variant="outline"
                    onClick={() => exportMutation.mutate()}
                  >
                    {exportMutation.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Download />
                    )}
                    Export JSON
                  </Button>
                </div>
              </section>
      </div>

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
  displayNameRef,
  form,
  onChange,
  prefix,
}: {
  displayNameRef?: Ref<HTMLInputElement>
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
          ref={displayNameRef}
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
            onChange={(event) => onChange({ ...form, args: event.target.value })}
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
  link.download = `xedoc-accounts-${new Date()
    .toISOString()
    .slice(0, 10)}.json`
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

function accountLabel(count: number): string {
  return count === 1 ? "account" : "accounts"
}

function normalizeAccountAuthMode(value: unknown): AccountAuthMode | null {
  return value === "browser" || value === "device" ? value : null
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
