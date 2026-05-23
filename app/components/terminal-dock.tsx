import type {
  TerminalProjectPayload,
  TerminalSession,
} from "@/types"
import {
  type TerminalAttachResponse,
  type TerminalCloseResponse,
  type TerminalCreateResponse,
  type TerminalListResponse,
  type TerminalRequestEvent,
  type TerminalSocket,
  terminalRequest,
} from "@/lib/terminal-socket"
import { cn } from "@/lib/utils"
import { Loader2, Plus, Terminal as TerminalIcon, X } from "lucide-react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "./ui/button"

type GhosttyModule = typeof import("ghostty-web")
type GhosttyFitAddon = InstanceType<GhosttyModule["FitAddon"]>
type GhosttyTerminal = InstanceType<GhosttyModule["Terminal"]>
type GhosttyDisposable = { dispose(): void }

const TERMINAL_HEIGHT_STORAGE_KEY = "xedoc.web.terminal-height"
const MIN_TERMINAL_HEIGHT = 220
const MIN_MOBILE_TERMINAL_HEIGHT = 160
const DEFAULT_TERMINAL_HEIGHT = 360
const DEFAULT_MOBILE_TERMINAL_HEIGHT = 300
const MOBILE_BREAKPOINT_WIDTH = 640

let ghosttyModulePromise: Promise<GhosttyModule> | null = null

export function TerminalDock({
  className,
  onClosePanel,
  projectPath,
  socket,
  socketConnected,
}: {
  className?: string
  onClosePanel?: () => void
  projectPath: string
  socket: TerminalSocket | null
  socketConnected: boolean
}) {
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState(readStoredTerminalHeight)
  const [loading, setLoading] = useState(false)
  const [resolvedProjectPath, setResolvedProjectPath] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<TerminalSession[]>([])
  const heightRef = useRef(height)
  const compactLayout = useCompactTerminalLayout()

  const request = useCallback(
    <TResponse extends Record<string, unknown>>(
      event: TerminalRequestEvent,
      payload: Record<string, unknown>,
    ) => terminalRequest<TResponse>(socket, event, payload),
    [socket],
  )

  const applyTerminalList = useCallback((nextTerminals: TerminalSession[]) => {
    setTerminals(nextTerminals)
    setActiveTerminalId((current) => {
      if (current && nextTerminals.some((terminal) => terminal.id === current)) {
        return current
      }
      return nextTerminals[0]?.id ?? null
    })
  }, [])

  const createTerminal = useCallback(async () => {
    const path = resolvedProjectPath ?? projectPath
    const response = await request<TerminalCreateResponse>("terminal:create", {
      cols: 80,
      projectPath: path,
      rows: 24,
    })
    setResolvedProjectPath(response.projectPath)
    applyTerminalList(response.terminals)
    setActiveTerminalId(response.terminal.id)
  }, [applyTerminalList, projectPath, request, resolvedProjectPath])

  useEffect(() => {
    if (!socket || !projectPath.trim()) {
      setTerminals([])
      setActiveTerminalId(null)
      setResolvedProjectPath(null)
      return
    }

    let cancelled = false
    let joinedProjectPath: string | null = null
    setLoading(true)
    setError(null)

    request<TerminalListResponse>("terminal:project:join", { projectPath })
      .then(async (response) => {
        if (cancelled) {
          return
        }
        joinedProjectPath = response.projectPath
        setResolvedProjectPath(response.projectPath)
        applyTerminalList(response.terminals)
        if (!response.terminals.length) {
          const created = await request<TerminalCreateResponse>("terminal:create", {
            cols: 80,
            projectPath: response.projectPath,
            rows: 24,
          })
          if (!cancelled) {
            setResolvedProjectPath(created.projectPath)
            applyTerminalList(created.terminals)
            setActiveTerminalId(created.terminal.id)
          }
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(readError(caught))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
      if (joinedProjectPath) {
        void terminalRequest(socket, "terminal:project:leave", {
          projectPath: joinedProjectPath,
        }).catch(() => undefined)
      }
    }
  }, [applyTerminalList, projectPath, request, socket])

  useEffect(() => {
    if (!socket) {
      return
    }
    const handleProject = (payload: TerminalProjectPayload) => {
      const activeProjectPath = resolvedProjectPath ?? projectPath
      if (payload.projectPath === activeProjectPath) {
        applyTerminalList(payload.terminals)
      }
    }
    socket.on("terminal:project", handleProject)
    return () => {
      socket.off("terminal:project", handleProject)
    }
  }, [applyTerminalList, projectPath, resolvedProjectPath, socket])

  useEffect(() => {
    heightRef.current = height
    const timeout = window.setTimeout(() => {
      writeStoredTerminalHeight(height)
    }, 150)
    return () => window.clearTimeout(timeout)
  }, [height])

  useEffect(() => {
    const handleResize = () => {
      setHeight((current) => {
        const nextHeight = clampTerminalHeight(current)
        heightRef.current = nextHeight
        return nextHeight
      })
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      try {
        const response = await request<TerminalCloseResponse>("terminal:close", {
          terminalId,
        })
        applyTerminalList(response.terminals)
      } catch (caught) {
        toast.error(readError(caught))
      }
    },
    [applyTerminalList, request],
  )

  const updateTerminal = useCallback((terminal: TerminalSession) => {
    setTerminals((current) =>
      current.map((entry) => entry.id === terminal.id ? terminal : entry),
    )
  }, [])

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      const startY = event.clientY
      const startHeight = height
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextHeight = clampTerminalHeight(
          startHeight + startY - moveEvent.clientY,
        )
        heightRef.current = nextHeight
        setHeight(nextHeight)
      }
      const stopResize = () => {
        writeStoredTerminalHeight(heightRef.current)
        document.removeEventListener("pointermove", handlePointerMove)
        document.removeEventListener("pointerup", stopResize)
      }
      document.addEventListener("pointermove", handlePointerMove)
      document.addEventListener("pointerup", stopResize)
    },
    [height],
  )

  return (
    <section
      className={cn(
        "grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border bg-background shadow-sm",
        className,
      )}
      style={{ height }}
    >
      <button
        aria-label="Resize terminal"
        className="group flex h-3 cursor-row-resize items-center justify-center border-b bg-muted/40"
        type="button"
        onPointerDown={startResize}
      >
        <span className="h-0.5 w-10 rounded-full bg-muted-foreground/35 group-hover:bg-muted-foreground/70" />
      </button>
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <div className="flex min-w-0 items-center gap-1 border-b bg-muted/25 px-2 py-1">
          <div
            aria-label="Terminals"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            role="tablist"
          >
            {terminals.map((terminal) => (
              <div
                className={cn(
                  "flex h-7 min-w-24 max-w-48 shrink-0 items-center rounded-md text-[11px] sm:h-8 sm:min-w-28 sm:max-w-56 sm:text-xs",
                  terminal.id === activeTerminalId
                    ? "bg-secondary text-secondary-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                  terminal.status === "exited" && "text-muted-foreground",
                )}
                key={terminal.id}
              >
                <button
                  aria-selected={terminal.id === activeTerminalId}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left"
                  role="tab"
                  title={terminal.title}
                  type="button"
                  onClick={() => setActiveTerminalId(terminal.id)}
                >
                  <TerminalIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{terminal.title || "Shell"}</span>
                  <span
                    className={cn(
                      "ml-auto size-1.5 shrink-0 rounded-full",
                      terminal.status === "running"
                        ? "bg-emerald-500"
                        : "bg-muted-foreground/50",
                    )}
                  />
                </button>
                <button
                  aria-label="Close terminal"
                  className="mr-1 grid size-5 shrink-0 place-items-center rounded-sm hover:bg-background"
                  title="Close terminal"
                  type="button"
                  onClick={() => {
                    void closeTerminal(terminal.id)
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
          <Button
            aria-label="New terminal"
            className="size-8 shrink-0"
            disabled={!socketConnected || loading}
            size="icon-sm"
            title="New terminal"
            type="button"
            variant="ghost"
            onClick={() => {
              void createTerminal().catch((caught) => toast.error(readError(caught)))
            }}
          >
            {loading ? <Loader2 className="animate-spin" /> : <Plus />}
          </Button>
          {onClosePanel ? (
            <Button
              aria-label="Hide terminal panel"
              className="size-8 shrink-0"
              size="icon-sm"
              title="Hide terminal panel"
              type="button"
              variant="ghost"
              onClick={onClosePanel}
            >
              <X />
            </Button>
          ) : null}
        </div>
        <div className="relative min-h-0 bg-zinc-950">
          {error ? (
            <div className="grid h-full place-items-center p-4 text-sm text-red-200">
              {error}
            </div>
          ) : terminals.length ? (
            terminals.map((terminal) => (
              <TerminalPane
                active={terminal.id === activeTerminalId}
                compactLayout={compactLayout}
                key={terminal.id}
                resizeSignal={height}
                socket={socket}
                terminal={terminal}
                onTerminalUpdated={updateTerminal}
              />
            ))
          ) : (
            <div className="grid h-full place-items-center p-4 text-sm text-zinc-400">
              {loading ? "Starting terminal..." : "No terminal"}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function TerminalPane({
  active,
  compactLayout,
  onTerminalUpdated,
  resizeSignal,
  socket,
  terminal,
}: {
  active: boolean
  compactLayout: boolean
  onTerminalUpdated: (terminal: TerminalSession) => void
  resizeSignal: number
  socket: TerminalSocket | null
  terminal: TerminalSession
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fitAddonRef = useRef<GhosttyFitAddon | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  const terminalRef = useRef<GhosttyTerminal | null>(null)
  const [ready, setReady] = useState(false)

  const requestFit = useCallback(() => {
    if (fitFrameRef.current !== null) {
      return
    }
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null
      fitAddonRef.current?.fit()
    })
  }, [])

  useEffect(() => {
    requestFit()
    return () => {
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
    }
  }, [requestFit, resizeSignal])

  useEffect(() => {
    if (!active) {
      return
    }
    requestFit()
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit()
      terminalRef.current?.focus()
    })
  }, [active, requestFit])

  useEffect(() => {
    const element = containerRef.current
    if (!socket || !element) {
      return
    }

    let disposed = false
    let attached = false
    const disposables: GhosttyDisposable[] = []
    setReady(false)
    element.replaceChildren()

    const emitInput = (data: string) => {
      socket.emit("terminal:input", {
        data,
        terminalId: terminal.id,
      })
    }

    const handleOutput = (payload: { data: string; terminalId: string }) => {
      if (attached && payload.terminalId === terminal.id) {
        terminalRef.current?.write(payload.data)
      }
    }

    socket.on("terminal:output", handleOutput)

    void loadGhostty()
      .then(async ({ FitAddon, Terminal }) => {
        if (disposed || !containerRef.current) {
          return
        }
        containerRef.current.replaceChildren()
        const term = new Terminal({
          cursorBlink: true,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: compactLayout ? 11 : 12,
          scrollback: 10_000,
          theme: {
            background: "#09090b",
            foreground: "#e4e4e7",
          },
        })
        const fitAddon = new FitAddon()
        fitAddonRef.current = fitAddon
        terminalRef.current = term
        term.loadAddon(fitAddon)
        term.open(containerRef.current)
        fitAddon.fit()
        fitAddon.observeResize()
        term.attachCustomKeyEventHandler((event) => {
          if (event.key !== "Enter") {
            return false
          }
          emitInput("\r")
          return true
        })
        disposables.push(fitAddon)
        disposables.push(
          term.onData((data) => {
            emitInput(data)
          }),
        )
        disposables.push(
          term.onResize((size) => {
            socket.emit("terminal:resize", {
              cols: size.cols,
              rows: size.rows,
              terminalId: terminal.id,
            })
          }),
        )
        disposables.push(
          term.onTitleChange((title) => {
            socket.emit("terminal:title", {
              terminalId: terminal.id,
              title,
            })
          }),
        )

        const response = await terminalRequest<TerminalAttachResponse>(
          socket,
          "terminal:attach",
          { terminalId: terminal.id },
        )
        if (disposed) {
          return
        }
        onTerminalUpdated(response.terminal)
        if (response.replay) {
          term.write(response.replay)
        }
        attached = true
        requestAnimationFrame(() => {
          fitAddon.fit()
          if (!disposed) {
            setReady(true)
            if (active) {
              term.focus()
            }
          }
        })
        requestFit()
      })
      .catch((caught) => {
        if (!disposed) {
          toast.error(readError(caught))
        }
      })

    return () => {
      disposed = true
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      socket.off("terminal:output", handleOutput)
      void terminalRequest(socket, "terminal:detach", {
        terminalId: terminal.id,
      }).catch(() => undefined)
      for (const disposable of disposables) {
        disposable.dispose()
      }
      terminalRef.current?.dispose()
      element.replaceChildren()
      terminalRef.current = null
      fitAddonRef.current = null
      setReady(false)
    }
  }, [active, compactLayout, onTerminalUpdated, requestFit, socket, terminal.id])

  return (
    <div
      className={cn(
        "absolute inset-0 h-full min-h-0 overflow-hidden bg-zinc-950 p-1 outline-none sm:p-2",
        active ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none",
      )}
      aria-hidden={!active}
      style={{ caretColor: "transparent" }}
    >
      {!ready && active ? (
        <div className="absolute inset-0 grid place-items-center bg-zinc-950 text-xs text-zinc-500">
          Loading terminal...
        </div>
      ) : null}
      <div
        className={cn(
          "h-full min-h-0 transition-opacity [&_canvas]:block",
          ready ? "opacity-100" : "opacity-0",
        )}
        ref={containerRef}
      />
    </div>
  )
}

function useCompactTerminalLayout(): boolean {
  const [compact, setCompact] = useState(() => isMobileViewport())

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_WIDTH - 1}px)`)
    const updateCompact = () => setCompact(query.matches)
    updateCompact()
    query.addEventListener("change", updateCompact)
    return () => query.removeEventListener("change", updateCompact)
  }, [])

  return compact
}

async function loadGhostty(): Promise<GhosttyModule> {
  ghosttyModulePromise ??= import("ghostty-web").then(async (module) => {
    await module.init()
    return module
  })
  return ghosttyModulePromise
}

function readStoredTerminalHeight(): number {
  if (typeof window === "undefined") {
    return DEFAULT_TERMINAL_HEIGHT
  }
  const stored = Number.parseInt(
    window.localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY) ?? "",
    10,
  )
  return clampTerminalHeight(stored || defaultTerminalHeight())
}

function writeStoredTerminalHeight(height: number): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(height))
  }
}

function clampTerminalHeight(height: number): number {
  const minHeight =
    typeof window !== "undefined" && isMobileViewport()
      ? MIN_MOBILE_TERMINAL_HEIGHT
      : MIN_TERMINAL_HEIGHT
  const maxHeight =
    typeof window === "undefined"
      ? 720
      : Math.max(
          minHeight,
          Math.min(window.innerHeight - (isMobileViewport() ? 96 : 140), 760),
        )
  return Math.max(minHeight, Math.min(maxHeight, height))
}

function defaultTerminalHeight(): number {
  return isMobileViewport() ? DEFAULT_MOBILE_TERMINAL_HEIGHT : DEFAULT_TERMINAL_HEIGHT
}

function isMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.innerWidth < MOBILE_BREAKPOINT_WIDTH
  )
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Terminal request failed."
}
