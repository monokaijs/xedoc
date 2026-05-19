import type { WorkspaceDirectoryResponse, WorkspaceEntry } from "@/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  ChevronRight,
  File,
  Folder,
  FolderPlus,
  FolderOpen,
  Home,
  RefreshCw,
  Search,
  X,
} from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
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
import { ScrollArea } from "@/components/ui/scroll-area"
import { createWorkspaceDirectory, listWorkspaceDirectory } from "@/lib/api"
import type { WebSession } from "@/lib/session-storage"
import { cn } from "@/lib/utils"

export function WorkspacePickerDialog({
  initialPath,
  mode = "directory",
  onOpenChange,
  onSelect,
  open,
  session,
}: {
  initialPath?: string | null
  mode?: "directory" | "file"
  onOpenChange: (open: boolean) => void
  onSelect: (path: string, type?: WorkspaceEntry["type"]) => void
  open: boolean
  session: WebSession
}) {
  const queryClient = useQueryClient()
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState(initialPath ?? "")
  const [selectedType, setSelectedType] = useState<WorkspaceEntry["type"]>("directory")
  const [manualPath, setManualPath] = useState(initialPath ?? "")
  const [filter, setFilter] = useState("")
  const [showPath, setShowPath] = useState(true)
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [createFolderParentPath, setCreateFolderParentPath] = useState("")
  const [newFolderName, setNewFolderName] = useState("")

  const rootQuery = useQuery({
    enabled: open,
    queryKey: workspaceDirectoryQueryKey(session, undefined),
    queryFn: () => listWorkspaceDirectory(session, undefined),
  })
  const rootDirectory = rootQuery.data
  const rootPath = rootDirectory?.root ?? rootDirectory?.path ?? ""
  const effectiveSelectedPath = selectedPath || rootDirectory?.path || ""

  const createFolderMutation = useMutation({
    mutationFn: () => {
      const parentPath =
        createFolderParentPath || effectiveSelectedPath || rootDirectory?.path
      const name = newFolderName.trim()
      if (!parentPath) {
        throw new Error("Select a folder first.")
      }
      if (!name) {
        throw new Error("Enter a folder name.")
      }
      return createWorkspaceDirectory(session, { parentPath, name })
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (directory) => {
      setShowCreateFolder(false)
      setCreateFolderParentPath("")
      setNewFolderName("")
      toast.success("Folder created.")
      void queryClient.invalidateQueries({
        queryKey: ["workspace-directory", session.serverUrl],
      })
      openDirectory(directory.path)
    },
  })

  useEffect(() => {
    if (!open) {
      return
    }
    setExpandedPaths(new Set())
    setSelectedPath(initialPath ?? "")
    setSelectedType("directory")
    setManualPath(initialPath ?? "")
    setFilter("")
    setShowPath(true)
    setShowCreateFolder(false)
    setCreateFolderParentPath("")
    setNewFolderName("")
  }, [initialPath, open])

  useEffect(() => {
    if (!rootDirectory) {
      return
    }
    const nextPath = initialPath || rootDirectory.path
    setSelectedPath((current) => current || nextPath)
    setManualPath((current) => current || nextPath)
    setExpandedPaths((current) => {
      const next = new Set(current)
      for (const path of ancestorPaths(nextPath, rootDirectory.root)) {
        next.add(path)
      }
      return next
    })
  }, [initialPath, rootDirectory])

  function selectPath(path: string, type: WorkspaceEntry["type"] = "directory") {
    setSelectedPath(path)
    setSelectedType(type)
    setManualPath(path)
    if (rootPath) {
      setExpandedPaths((current) => {
        const next = new Set(current)
        for (const ancestor of ancestorPaths(path, rootPath)) {
          next.add(ancestor)
        }
        return next
      })
    }
  }

  function toggleDirectory(path: string) {
    setSelectedPath(path)
    setSelectedType("directory")
    setManualPath(path)
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  function openDirectory(path: string) {
    setSelectedPath(path)
    setSelectedType("directory")
    setManualPath(path)
    setExpandedPaths((current) => new Set(current).add(path))
  }

  function openManualPath() {
    const nextPath = manualPath.trim() || rootDirectory?.path
    if (nextPath) {
      selectPath(nextPath)
    }
  }

  function moveHome() {
    if (rootDirectory?.path) {
      openDirectory(rootDirectory.path)
    }
  }

  function refreshTree() {
    void queryClient.invalidateQueries({
      queryKey: ["workspace-directory", session.serverUrl],
    })
  }

  function startCreateFolder() {
    const parentPath = effectiveSelectedPath || rootDirectory?.path
    if (!parentPath) {
      return
    }
    setSelectedPath(parentPath)
    setSelectedType("directory")
    setManualPath(parentPath)
    setFilter("")
    setShowCreateFolder(true)
    setCreateFolderParentPath(parentPath)
    setNewFolderName("")
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (rootPath) {
        for (const ancestor of ancestorPaths(parentPath, rootPath)) {
          next.add(ancestor)
        }
      }
      next.add(parentPath)
      return next
    })
  }

  function chooseSelectedPath() {
    if (!effectiveSelectedPath || (mode === "file" && selectedType !== "file")) {
      return
    }
    onSelect(effectiveSelectedPath)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-0 overflow-hidden rounded-xl bg-background p-0 ring-border sm:max-w-2xl">
        <DialogHeader className="gap-1 px-4 pb-2 pt-3">
          <DialogTitle>
            {mode === "file" ? "Choose Workspace File" : "Choose Working Directory"}
          </DialogTitle>
          <DialogDescription className="truncate">
            {rootDirectory?.root
              ? `Workspace root: ${rootDirectory.root}`
              : mode === "file"
                ? "Pick a file from the workspace."
                : "Pick a project folder for Codex."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
          <div className="grid gap-1.5 px-3 pb-2 pt-1">
            <div className="flex min-w-0 items-center gap-1">
              <IconButton label="Home" onClick={moveHome}>
                <Home />
              </IconButton>
              <IconButton
                disabled={!effectiveSelectedPath || createFolderMutation.isPending}
                label="New folder"
                onClick={startCreateFolder}
              >
                <FolderPlus />
              </IconButton>
              <IconButton label="Refresh" onClick={refreshTree}>
                <RefreshCw
                  className={cn(rootQuery.isFetching && "animate-spin")}
                />
              </IconButton>

              <div className="ml-auto flex min-w-0 items-center gap-2">
                <div className="relative hidden min-w-0 sm:block">
                  <Search className="pointer-events-none absolute left-2 top-1.5 size-4 text-muted-foreground" />
                  <Input
                    className="h-7 w-44 border-border/70 bg-muted/40 pl-7 text-xs"
                    placeholder="Filter"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </div>
                <Button
                  className="h-7 px-2 text-xs"
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setShowPath((value) => !value)}
                >
                  {showPath ? "Hide path" : "Show path"}
                </Button>
              </div>
            </div>

            {showPath ? (
              <div className="flex min-w-0 items-center gap-1">
                <Input
                  autoCapitalize="none"
                  className="h-8 min-w-0 border-border/70 bg-muted/40 font-mono text-xs"
                  spellCheck={false}
                  value={manualPath}
                  onChange={(event) => setManualPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      openManualPath()
                    }
                  }}
                />
                <IconButton label="Open path" onClick={openManualPath}>
                  <ChevronRight />
                </IconButton>
              </div>
            ) : null}

            <div className="relative sm:hidden">
              <Search className="pointer-events-none absolute left-2 top-1.5 size-4 text-muted-foreground" />
              <Input
                className="h-7 border-border/70 bg-muted/40 pl-7 text-xs"
                placeholder="Filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
          </div>

          <div className="min-h-0 bg-background">
            {rootQuery.error ? (
              <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {rootQuery.error.message || "Unable to browse workspace."}
              </div>
            ) : (
              <ScrollArea className="h-[46vh] min-h-72">
                <div className="p-1">
                  {rootQuery.isLoading ? (
                    <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                      Loading directories...
                    </div>
                  ) : null}

                  {rootDirectory ? (
                    <DirectoryTreeNode
                      directory={rootDirectory}
                      entry={{
                        name: displayNameForPath(rootDirectory.path),
                        path: rootDirectory.path,
                        type: "directory",
                      }}
                      expandedPaths={expandedPaths}
                      filter={filter}
                      level={0}
                      createFolderName={newFolderName}
                      createFolderParentPath={createFolderParentPath}
                      createFolderPending={createFolderMutation.isPending}
                      selectedPath={effectiveSelectedPath}
                      selectedType={selectedType}
                      session={session}
                      showCreateFolder={showCreateFolder}
                      onCancelCreateFolder={() => {
                        setShowCreateFolder(false)
                        setCreateFolderParentPath("")
                        setNewFolderName("")
                      }}
                      onCreateFolderNameChange={setNewFolderName}
                      onCreateFolderSubmit={() => createFolderMutation.mutate()}
                      onOpen={openDirectory}
                      onSelect={selectPath}
                      onToggle={toggleDirectory}
                    />
                  ) : null}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none border-t bg-muted/35 px-3 py-2 sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            <span className="mr-1 font-medium text-foreground">Selected:</span>
            <span className="font-mono">
              {mode === "file" && selectedType !== "file"
                ? "Choose a file"
                : effectiveSelectedPath || rootPath || "None"}
            </span>
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <Button
              disabled={!effectiveSelectedPath || (mode === "file" && selectedType !== "file")}
              size="sm"
              type="button"
              onClick={chooseSelectedPath}
            >
              <Check />
              {mode === "file" ? "Attach" : "OK"}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DirectoryTreeNode({
  createFolderName,
  createFolderParentPath,
  createFolderPending,
  directory,
  entry,
  expandedPaths,
  filter,
  level,
  onCancelCreateFolder,
  onCreateFolderNameChange,
  onCreateFolderSubmit,
  onOpen,
  onSelect,
  onToggle,
  selectedPath,
  selectedType,
  session,
  showCreateFolder,
}: {
  createFolderName: string
  createFolderParentPath: string
  createFolderPending: boolean
  directory?: WorkspaceDirectoryResponse
  entry: WorkspaceEntry
  expandedPaths: Set<string>
  filter: string
  level: number
  onCancelCreateFolder: () => void
  onCreateFolderNameChange: (name: string) => void
  onCreateFolderSubmit: () => void
  onOpen: (path: string) => void
  onSelect: (path: string) => void
  onToggle: (path: string) => void
  selectedPath: string
  selectedType: WorkspaceEntry["type"]
  session: WebSession
  showCreateFolder: boolean
}) {
  const expanded = expandedPaths.has(entry.path)
  const selected =
    normalizePathForCompare(selectedPath) === normalizePathForCompare(entry.path)
  const showsCreateFolderRow =
    showCreateFolder &&
    normalizePathForCompare(createFolderParentPath) ===
      normalizePathForCompare(entry.path)
  const query = useQuery({
    enabled: expanded && !directory,
    queryKey: workspaceDirectoryQueryKey(session, entry.path),
    queryFn: () => listWorkspaceDirectory(session, entry.path),
  })
  const currentDirectory = directory ?? query.data
  const entries = useMemo(
    () => filterEntries(currentDirectory?.entries ?? [], filter),
    [currentDirectory?.entries, filter],
  )
  const directories = entries.filter((child) => child.type === "directory")
  const files = entries.filter((child) => child.type !== "directory")

  return (
    <div className="min-w-0">
      <DirectoryRow
        entry={entry}
        expanded={expanded}
        level={level}
        loading={query.isFetching}
        selected={selected}
        onOpen={onOpen}
        onSelect={onSelect}
        onToggle={onToggle}
      />

      {expanded ? (
        <div className="min-w-0">
          {query.error ? (
            <div
              className="h-7 truncate px-2 text-xs leading-7 text-destructive"
              style={{ paddingLeft: `${34 + (level + 1) * 18}px` }}
            >
              {query.error.message || "Unable to load folder."}
            </div>
          ) : null}

          {query.isLoading ? (
            <div
              className="h-7 truncate px-2 text-xs leading-7 text-muted-foreground"
              style={{ paddingLeft: `${34 + (level + 1) * 18}px` }}
            >
              Loading...
            </div>
          ) : null}

          {showsCreateFolderRow ? (
            <CreateFolderRow
              level={level + 1}
              name={createFolderName}
              pending={createFolderPending}
              onCancel={onCancelCreateFolder}
              onNameChange={onCreateFolderNameChange}
              onSubmit={onCreateFolderSubmit}
            />
          ) : null}

          {directories.map((child) => (
            <DirectoryTreeNode
              createFolderName={createFolderName}
              createFolderParentPath={createFolderParentPath}
              createFolderPending={createFolderPending}
              entry={child}
              expandedPaths={expandedPaths}
              filter={filter}
              key={child.path}
              level={level + 1}
              showCreateFolder={showCreateFolder}
              selectedPath={selectedPath}
              selectedType={selectedType}
              session={session}
              onCancelCreateFolder={onCancelCreateFolder}
              onCreateFolderNameChange={onCreateFolderNameChange}
              onCreateFolderSubmit={onCreateFolderSubmit}
              onOpen={onOpen}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}

          {files.map((child) => (
            <FileRow
              entry={child}
              key={child.path}
              level={level + 1}
              selected={
                selectedType === "file" &&
                normalizePathForCompare(selectedPath) === normalizePathForCompare(child.path)
              }
              onSelect={onSelect}
            />
          ))}

          {currentDirectory && !entries.length && !showsCreateFolderRow ? (
            <div
              className="h-7 truncate px-2 text-xs leading-7 text-muted-foreground"
              style={{ paddingLeft: `${34 + (level + 1) * 18}px` }}
            >
              No matching entries.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function CreateFolderRow({
  level,
  name,
  onCancel,
  onNameChange,
  onSubmit,
  pending,
}: {
  level: number
  name: string
  onCancel: () => void
  onNameChange: (name: string) => void
  onSubmit: () => void
  pending: boolean
}) {
  return (
    <form
      className="grid h-8 min-w-0 grid-cols-[1.5rem_1rem_minmax(0,1fr)_auto_auto] items-center gap-1 rounded-sm px-1 text-sm"
      style={{ paddingLeft: `${4 + level * 18}px` }}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <span />
      <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
      <Input
        autoCapitalize="none"
        autoFocus
        className="h-7 min-w-0 border-border/70 bg-muted/40 text-xs"
        disabled={pending}
        placeholder="Folder name"
        spellCheck={false}
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
      />
      <IconButton
        disabled={!name.trim() || pending}
        label="Create folder"
        onClick={onSubmit}
      >
        <Check />
      </IconButton>
      <IconButton disabled={pending} label="Cancel new folder" onClick={onCancel}>
        <X />
      </IconButton>
    </form>
  )
}

function DirectoryRow({
  entry,
  expanded,
  level,
  loading,
  onOpen,
  onSelect,
  onToggle,
  selected,
}: {
  entry: WorkspaceEntry
  expanded: boolean
  level: number
  loading?: boolean
  onOpen: (path: string) => void
  onSelect: (path: string) => void
  onToggle: (path: string) => void
  selected: boolean
}) {
  return (
    <div
      className={cn(
        "group grid h-7 min-w-0 grid-cols-[1.5rem_1rem_minmax(0,1fr)] items-center gap-1 rounded-sm px-1 text-sm",
        selected
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/55",
      )}
      style={{ paddingLeft: `${4 + level * 18}px` }}
    >
      <button
        className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        title={expanded ? "Collapse" : "Expand"}
        type="button"
        onClick={() => onToggle(entry.path)}
      >
        <ChevronRight
          className={cn(
            "size-4 transition-transform",
            expanded && "rotate-90",
            loading && "opacity-50",
          )}
        />
      </button>
      {expanded ? (
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <Folder className="size-4 shrink-0 text-muted-foreground" />
      )}
      <button
        className="min-w-0 truncate text-left"
        title={entry.path}
        type="button"
        onClick={() => onSelect(entry.path)}
        onDoubleClick={() => onOpen(entry.path)}
      >
        {entry.name}
      </button>
    </div>
  )
}

function FileRow({
  entry,
  level,
  onSelect,
  selected,
}: {
  entry: WorkspaceEntry
  level: number
  onSelect: (path: string, type?: WorkspaceEntry["type"]) => void
  selected: boolean
}) {
  return (
    <button
      className={cn(
        "grid h-7 min-w-0 w-full grid-cols-[1.5rem_1rem_minmax(0,1fr)] items-center gap-1 rounded-sm px-1 text-left text-sm",
        selected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
      )}
      style={{ paddingLeft: `${4 + level * 18}px` }}
      title={entry.path}
      type="button"
      onClick={() => onSelect(entry.path, "file")}
    >
      <span />
      <File className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{entry.name}</span>
    </button>
  )
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <Button
      className="size-7 p-0"
      disabled={disabled}
      size="icon"
      title={label}
      type="button"
      variant="ghost"
      onClick={onClick}
    >
      {children}
      <span className="sr-only">{label}</span>
    </Button>
  )
}

function workspaceDirectoryQueryKey(
  session: WebSession,
  path: string | undefined,
) {
  return ["workspace-directory", session.serverUrl, path] as const
}

function displayNameForPath(path: string) {
  const normalized = path.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || path
}

function filterEntries(entries: WorkspaceEntry[], filter: string) {
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const filtered = normalizedFilter
    ? entries.filter((entry) =>
        entry.name.toLocaleLowerCase().includes(normalizedFilter),
      )
    : entries
  return filtered.slice(0, 400)
}

function ancestorPaths(path: string, root: string) {
  const normalizedRoot = trimPathSeparator(root)
  const normalizedPath = trimPathSeparator(path)
  if (!normalizedRoot || !normalizedPath.startsWith(normalizedRoot)) {
    return normalizedRoot ? [normalizedRoot] : []
  }

  const ancestors = [normalizedRoot]
  const relative = normalizedPath
    .slice(normalizedRoot.length)
    .replace(/^[\\/]+/, "")
  let current = normalizedRoot
  for (const part of relative.split(/[\\/]/).filter(Boolean)) {
    current = joinDisplayPath(current, part)
    ancestors.push(current)
  }
  return ancestors
}

function joinDisplayPath(base: string, child: string) {
  const separator = base.includes("\\") ? "\\" : "/"
  return `${trimPathSeparator(base)}${separator}${child}`
}

function trimPathSeparator(path: string) {
  if (path === "/" || /^[A-Za-z]:[\\/]?$/.test(path)) {
    return path.replace(/[\\/]+$/, "") || path
  }
  return path.replace(/[\\/]+$/, "")
}

function normalizePathForCompare(path: string) {
  return trimPathSeparator(path).toLocaleLowerCase()
}

function readError(caught: unknown) {
  return caught instanceof Error ? caught.message : "Request failed."
}
