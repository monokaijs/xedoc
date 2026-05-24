import type {
  AccountAuthMode,
  AccountResponse,
  AuthenticateAccountResponse,
} from "@/types"
import { CheckCircle2, Copy, ExternalLink, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export interface AuthenticationDialogState {
  accountId: string
  accountName: string
  authUrl: string | null
  message: string | null
  mode: AccountAuthMode
  status: string
  userCode: string | null
}

export function AuthenticationDialog({
  callbackUrl,
  cancelPending,
  completePending,
  state,
  onCallbackUrlChange,
  onCancelAuthentication,
  onClose,
  onComplete,
  onCopyDeviceCode,
  onReopen,
}: {
  callbackUrl: string
  cancelPending: boolean
  completePending: boolean
  state: AuthenticationDialogState | null
  onCallbackUrlChange: (value: string) => void
  onCancelAuthentication: () => void
  onClose: () => void
  onComplete: () => void
  onCopyDeviceCode: () => void
  onReopen: () => void
}) {
  const isDevice = state?.mode === "device"
  const connected = state?.status === "CONNECTED"

  return (
    <Dialog
      open={!!state}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isDevice ? "Device authentication" : "Normal authentication"}
          </DialogTitle>
          <DialogDescription>
            {state?.accountName ?? "Codex account"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-sm",
              connected
                ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/35 dark:text-emerald-200"
                : "bg-muted/35 text-muted-foreground",
            )}
          >
            {connected
              ? "Codex reported this account as connected. xedoc will use the email from the authenticated account as its name."
              : isDevice
                ? "Open the verification link, enter the device code, then use the response URL field if Codex does not finish automatically."
                : "Complete the browser login. If the browser lands on a localhost callback page, paste that full URL below."}
          </div>

          {state?.authUrl ? (
            <div className="grid gap-2">
              <Label htmlFor="account-auth-url">
                {isDevice ? "Verification link" : "Authentication link"}
              </Label>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  className="font-mono text-xs"
                  id="account-auth-url"
                  readOnly
                  value={state.authUrl}
                />
                <Button variant="outline" onClick={onReopen}>
                  <ExternalLink />
                  Reopen
                </Button>
              </div>
            </div>
          ) : null}

          {isDevice && state?.userCode ? (
            <div className="grid gap-2">
              <Label htmlFor="account-device-code">Device code</Label>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  className="font-mono text-sm tracking-wider"
                  id="account-device-code"
                  readOnly
                  value={state.userCode}
                />
                <Button variant="outline" onClick={onCopyDeviceCode}>
                  <Copy />
                  Copy
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="account-callback-url">Response URL</Label>
            <Textarea
              className="min-h-24 font-mono text-xs"
              id="account-callback-url"
              placeholder="http://localhost:1455/auth/callback?code=..."
              value={callbackUrl}
              onChange={(event) => onCallbackUrlChange(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Paste the complete localhost callback URL from the Codex browser
              tab when automatic completion is blocked.
            </p>
          </div>

          {state?.message ? (
            <p className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
              {state.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <X />
            Close
          </Button>
          {state?.status === "AUTHENTICATING" ? (
            <Button
              disabled={!state.accountId || cancelPending}
              variant="destructive"
              onClick={onCancelAuthentication}
            >
              {cancelPending ? <Loader2 className="animate-spin" /> : <X />}
              Cancel Auth
            </Button>
          ) : null}
          <Button
            disabled={!state?.authUrl}
            variant="secondary"
            onClick={onReopen}
          >
            <ExternalLink />
            Reopen Link
          </Button>
          <Button
            disabled={
              !state?.accountId || !callbackUrl.trim() || completePending
            }
            onClick={onComplete}
          >
            {completePending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <CheckCircle2 />
            )}
            Submit Response URL
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function normalizeAccountAuthMode(
  value: unknown,
): AccountAuthMode | null {
  return value === "browser" || value === "device" ? value : null
}

export function authenticationDialogFromAccount(
  account: AccountResponse | undefined,
  mode: AccountAuthMode,
): AuthenticationDialogState {
  return {
    accountId: account?.id ?? "",
    accountName: account?.displayName ?? "Codex account",
    authUrl: account?.lastAuthUrl ?? null,
    message:
      account?.status === "AUTHENTICATING"
        ? "Authentication is in progress."
        : "Starting Codex authentication.",
    mode,
    status: account?.status ?? "AUTHENTICATING",
    userCode: account?.lastAuthUserCode ?? null,
  }
}

export function authenticationDialogFromResponse(
  response: AuthenticateAccountResponse,
  account?: AccountResponse,
): AuthenticationDialogState {
  return {
    accountId: response.accountId,
    accountName: account?.displayName ?? "Codex account",
    authUrl: response.authUrl ?? account?.lastAuthUrl ?? null,
    message: response.message ?? null,
    mode:
      response.authMode ??
      normalizeAccountAuthMode(account?.lastAuthMode) ??
      "browser",
    status: response.status,
    userCode: response.userCode ?? account?.lastAuthUserCode ?? null,
  }
}

export function authenticationDialogEqual(
  left: AuthenticationDialogState,
  right: AuthenticationDialogState,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.accountName === right.accountName &&
    left.authUrl === right.authUrl &&
    left.message === right.message &&
    left.mode === right.mode &&
    left.status === right.status &&
    left.userCode === right.userCode
  )
}
