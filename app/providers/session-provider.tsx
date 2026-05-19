import type { PropsWithChildren } from "react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { exchangePassword, getSessionStatus } from "@/lib/api"
import {
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
  type WebSession,
} from "@/lib/session-storage"
import { normalizeServerUrl } from "@/lib/url"

interface SessionContextValue {
  loading: boolean
  session: WebSession | null
  clearSession: () => void
  refreshSession: () => Promise<void>
  setup: (password: string) => Promise<void>
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined)

export function SessionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<WebSession | null>(null)
  const [validated, setValidated] = useState(false)
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot,
  )
  const activeSession = session
  const loading = !hydrated || !validated

  useEffect(() => {
    if (!hydrated) {
      return
    }

    const storedSession = loadStoredSession()
    if (!storedSession) {
      setSession(null)
      setValidated(true)
      return
    }

    let active = true
    setValidated(false)
    getSessionStatus(storedSession)
      .then(() => {
        if (active) {
          setSession(storedSession)
          setValidated(true)
        }
      })
      .catch(() => {
        clearStoredSession()
        if (active) {
          setSession(null)
          setValidated(true)
        }
      })

    return () => {
      active = false
    }
  }, [hydrated])

  const setup = useCallback(async (password: string) => {
    const serverUrl = normalizeServerUrl(getApiOrigin())
    const { token } = await exchangePassword(serverUrl, password)
    const nextSession = {
      serverUrl,
      token,
    }
    saveStoredSession(nextSession)
    setSession(nextSession)
    setValidated(true)
  }, [])

  const refreshSession = useCallback(async () => {
    if (!activeSession) {
      return
    }
    await getSessionStatus(activeSession)
  }, [activeSession])

  const clearSession = useCallback(() => {
    clearStoredSession()
    setSession(null)
    setValidated(true)
  }, [])

  const value = useMemo(
    () => ({
      clearSession,
      loading,
      refreshSession,
      session: activeSession,
      setup,
    }),
    [clearSession, loading, refreshSession, activeSession, setup],
  )

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  )
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) {
    throw new Error("useSession must be used inside SessionProvider.")
  }
  return value
}

function getApiOrigin(): string {
  return import.meta.env.VITE_API_ORIGIN ?? window.location.origin
}

function subscribeToHydration(): () => void {
  return () => {}
}

function getHydratedSnapshot(): boolean {
  return true
}

function getServerHydratedSnapshot(): boolean {
  return false
}
