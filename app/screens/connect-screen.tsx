import { useEffect, useState } from "react"
import { Navigate, useNavigate } from "react-router"
import { KeyRound, Loader2, PlugZap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getAuthStatus } from "@/lib/api"
import { normalizeServerUrl } from "@/lib/url"
import { useSession } from "@/providers/session-provider"

export function ConnectScreen() {
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordConfigured, setPasswordConfigured] = useState<boolean | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { loading, session, setup } = useSession()
  const navigate = useNavigate()
  const setupMode = passwordConfigured === false

  useEffect(() => {
    let active = true
    setError(null)
    getAuthStatus(getApiOrigin())
      .then((status) => {
        if (active) {
          setPasswordConfigured(status.passwordConfigured)
        }
      })
      .catch((caught) => {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to read server auth status.",
          )
          setPasswordConfigured(true)
        }
      })
    return () => {
      active = false
    }
  }, [])

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (session) {
    return <Navigate replace to="/" />
  }

  if (passwordConfigured === null) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  async function submit() {
    setError(null)
    if (setupMode && password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }
    setSubmitting(true)
    try {
      await setup(password)
      navigate("/", { replace: true })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to connect.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4 py-8">
      <section className="w-full max-w-md rounded-xl border bg-background p-5 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {setupMode ? (
              <KeyRound className="size-5" />
            ) : (
              <PlugZap className="size-5" />
            )}
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-normal">
              {setupMode ? "Set Server Password" : "Connect Server"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {setupMode
                ? "Choose a password for this xedoc instance."
                : "Enter the server password for this xedoc instance."}
            </p>
          </div>
        </div>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="server-password">Server password</Label>
            <Input
              id="server-password"
              autoComplete={setupMode ? "new-password" : "current-password"}
              placeholder="Password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  canSubmit(password, confirmPassword, setupMode)
                ) {
                  void submit()
                }
              }}
            />
          </div>

          {setupMode ? (
            <div className="grid gap-2">
              <Label htmlFor="server-password-confirm">Confirm password</Label>
              <Input
                id="server-password-confirm"
                autoComplete="new-password"
                placeholder="Password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    canSubmit(password, confirmPassword, setupMode)
                  ) {
                    void submit()
                  }
                }}
              />
            </div>
          ) : null}

          {error ? (
            <div className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <Button
            disabled={
              !canSubmit(password, confirmPassword, setupMode) || submitting
            }
            onClick={() => void submit()}
          >
            {submitting ? (
              <Loader2 className="animate-spin" />
            ) : setupMode ? (
              <KeyRound />
            ) : (
              <PlugZap />
            )}
            {setupMode ? "Set Password" : "Connect"}
          </Button>
        </div>
      </section>
    </main>
  )
}

function canSubmit(
  password: string,
  confirmPassword: string,
  setupMode: boolean,
): boolean {
  return (
    password.trim().length > 0 &&
    (!setupMode || confirmPassword.trim().length > 0)
  )
}

function getApiOrigin(): string {
  return normalizeServerUrl(
    import.meta.env.VITE_API_ORIGIN ?? window.location.origin,
  )
}
