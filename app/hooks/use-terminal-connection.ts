import { useEffect, useState } from "react"
import type { WebSession } from "@/lib/session-storage"
import {
  connectTerminalSocket,
  type TerminalSocket,
} from "@/lib/terminal-socket"

export function useTerminalConnection(session: WebSession | null) {
  const [connected, setConnected] = useState(false)
  const [count, setCount] = useState(0)
  const [socket, setSocket] = useState<TerminalSocket | null>(null)

  useEffect(() => {
    if (!session) {
      setConnected(false)
      setCount(0)
      setSocket(null)
      return
    }

    const connection = connectTerminalSocket(session, {
      onClose: () => setConnected(false),
      onCount: (payload) => setCount(Math.max(0, payload.count)),
      onError: () => setConnected(false),
      onOpen: () => setConnected(true),
    })
    setSocket(connection.socket)
    return () => {
      connection.disconnect()
      setConnected(false)
      setSocket(null)
    }
  }, [session?.serverUrl, session?.token])

  return { connected, count, socket }
}
