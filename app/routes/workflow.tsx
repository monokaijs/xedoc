import type {
  AccountResponse,
  ChatResponse,
  CreateWorkflowTaskRequest,
  MessagePageResponse,
  UpdateWorkflowTaskRequest,
  WorkflowTaskResponse,
  WorkflowTaskStatus,
} from "@/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ClipboardList,
  Columns3,
  Folder,
  FolderOpen,
  LayoutList,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  SendHorizontal,
  Trash2,
} from "lucide-react"
import type { FormEvent } from "react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router"
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
import { Textarea } from "@/components/ui/textarea"
import {
  createChat,
  createWorkflowTask,
  deleteWorkflowTask,
  executeChatMessage,
  listWorkflowTasks,
  updateWorkflowTask,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  appendMessages,
  executeResponseMessages,
  hasAvailableAccountSnapshot,
  readError,
  selectBestAvailableAccount,
} from "@/screens/chat-runtime-utils"
import { useShellContext } from "@/screens/shell-context"

type WorkflowView = "board" | "list"

type WorkflowProject = {
  activeCount: number
  count: number
  key: string
  name: string
  path: string
}

type TaskFormState = {
  description: string
  id?: string
  mode: "create" | "edit"
  projectPath: string
  status: WorkflowTaskStatus
  title: string
}

const statuses = [
  "pending",
  "in_progress",
  "finished",
  "failed",
] as const satisfies readonly WorkflowTaskStatus[]

const statusLabels: Record<WorkflowTaskStatus, string> = {
  failed: "Failed",
  finished: "Finished",
  in_progress: "In progress",
  pending: "Pending",
}

export default function WorkflowRoute() {
  const {
    accountRateLimitFetching,
    accountRateLimitSnapshots,
    chats,
    connectedAccounts,
    lastOpenedChat,
    openAccountManagement,
    openWorkspacePicker,
    session,
    setActiveProjectPath,
  } = useShellContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [view, setView] = useState<WorkflowView>("board")
  const [selectedProjectPath, setSelectedProjectPath] = useState("")
  const [taskForm, setTaskForm] = useState<TaskFormState | null>(null)

  const tasksQuery = useQuery({
    queryKey: ["workflow-tasks"],
    queryFn: () => listWorkflowTasks(session),
    refetchInterval: 4_000,
  })
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data])
  const projects = useMemo(
    () => buildProjects(tasks, chats, lastOpenedChat),
    [chats, lastOpenedChat, tasks],
  )

  useEffect(() => {
    if (selectedProjectPath) {
      return
    }
    const defaultPath =
      lastOpenedChat?.workingDirectory?.trim() || projects[0]?.path || ""
    if (defaultPath) {
      setSelectedProjectPath(defaultPath)
    }
  }, [lastOpenedChat?.workingDirectory, projects, selectedProjectPath])

  useEffect(() => {
    setActiveProjectPath(selectedProjectPath)
    return () => setActiveProjectPath("")
  }, [selectedProjectPath, setActiveProjectPath])

  const selectedProject = useMemo(
    () => projects.find((project) => project.path === selectedProjectPath) ?? null,
    [projects, selectedProjectPath],
  )
  const visibleTasks = useMemo(
    () =>
      selectedProjectPath
        ? tasks.filter((task) => task.projectPath === selectedProjectPath)
        : tasks,
    [selectedProjectPath, tasks],
  )
  const selectedAccount = useMemo(
    () => {
      const quotaSelectionPending =
        connectedAccounts.some((account) => accountRateLimitFetching[account.id]) &&
        !hasAvailableAccountSnapshot(connectedAccounts, accountRateLimitSnapshots)
      if (quotaSelectionPending) {
        return null
      }
      return (
        selectBestAvailableAccount(connectedAccounts, accountRateLimitSnapshots) ??
        null
      )
    },
    [accountRateLimitFetching, accountRateLimitSnapshots, connectedAccounts],
  )

  const createTaskMutation = useMutation({
    mutationFn: (body: CreateWorkflowTaskRequest) =>
      createWorkflowTask(session, body),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (task) => {
      setTaskForm(null)
      setSelectedProjectPath(task.projectPath)
      void queryClient.invalidateQueries({ queryKey: ["workflow-tasks"] })
    },
  })

  const updateTaskMutation = useMutation({
    mutationFn: ({
      taskId,
      body,
    }: {
      body: UpdateWorkflowTaskRequest
      taskId: string
    }) => updateWorkflowTask(session, taskId, body),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (task) => {
      setTaskForm(null)
      setSelectedProjectPath(task.projectPath)
      void queryClient.invalidateQueries({ queryKey: ["workflow-tasks"] })
    },
  })

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => deleteWorkflowTask(session, taskId),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflow-tasks"] })
    },
  })

  const executeTaskMutation = useMutation({
    mutationFn: async (task: WorkflowTaskResponse) => {
      if (!selectedAccount) {
        throw new Error("Connect an account before executing a task.")
      }
      await updateWorkflowTask(session, task.id, { status: "in_progress" })
      const chat = await createWorkflowChat({
        account: selectedAccount,
        lastOpenedChat,
        projectPath: task.projectPath,
        session,
        title: `Task: ${task.title}`,
      })
      const response = await executeChatMessage(session, chat.id, {
        content: taskExecutionPrompt(task),
      })
      return { chat, response }
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: ({ chat, response }) => {
      queryClient.setQueryData<MessagePageResponse>(
        ["messages", chat.id],
        appendMessages(undefined, executeResponseMessages(response)),
      )
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      void queryClient.invalidateQueries({ queryKey: ["workflow-tasks"] })
      navigate(`/chat/${chat.id}`)
    },
  })

  const openCreateTask = () => {
    setTaskForm({
      description: "",
      mode: "create",
      projectPath:
        selectedProjectPath || lastOpenedChat?.workingDirectory?.trim() || "",
      status: "pending",
      title: "",
    })
  }

  const submitTaskForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!taskForm) {
      return
    }
    const values = {
      description: taskForm.description,
      projectPath: taskForm.projectPath,
      status: taskForm.status,
      title: taskForm.title,
    }
    if (taskForm.mode === "create") {
      createTaskMutation.mutate(values)
      return
    }
    updateTaskMutation.mutate({
      body: values,
      taskId: taskForm.id!,
    })
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <section className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ProjectRail
          projects={projects}
          selectedProjectPath={selectedProjectPath}
          onCreateTask={openCreateTask}
          onSelectProject={setSelectedProjectPath}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WorkflowToolbar
            project={selectedProject}
            projectPath={selectedProjectPath}
            view={view}
            onChooseProject={() =>
              openWorkspacePicker({
                initialPath: selectedProjectPath,
                onSelect: setSelectedProjectPath,
              })
            }
            onCreateTask={openCreateTask}
            onViewChange={setView}
          />
          {tasksQuery.error ? (
            <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {tasksQuery.error.message}
            </div>
          ) : null}
          <ScrollArea className="min-h-0 flex-1">
            {view === "board" ? (
              <WorkflowBoard
                deletingTaskId={deleteTaskMutation.variables ?? null}
                executingTaskId={executeTaskMutation.variables?.id ?? null}
                tasks={visibleTasks}
                updatingTaskId={updateTaskMutation.variables?.taskId ?? null}
                onDelete={(task) => deleteTaskMutation.mutate(task.id)}
                onEdit={setTaskFormFromTask}
                onExecute={(task) => executeTaskMutation.mutate(task)}
                onStatusChange={(task, status) =>
                  updateTaskMutation.mutate({
                    body: { status },
                    taskId: task.id,
                  })
                }
              />
            ) : (
              <WorkflowList
                deletingTaskId={deleteTaskMutation.variables ?? null}
                executingTaskId={executeTaskMutation.variables?.id ?? null}
                tasks={visibleTasks}
                updatingTaskId={updateTaskMutation.variables?.taskId ?? null}
                onDelete={(task) => deleteTaskMutation.mutate(task.id)}
                onEdit={setTaskFormFromTask}
                onExecute={(task) => executeTaskMutation.mutate(task)}
                onStatusChange={(task, status) =>
                  updateTaskMutation.mutate({
                    body: { status },
                    taskId: task.id,
                  })
                }
              />
            )}
          </ScrollArea>
        </div>
      </section>
      <WorkflowAssistantPanel
        account={selectedAccount}
        lastOpenedChat={lastOpenedChat}
        project={selectedProject}
        session={session}
        onAddAccount={() => openAccountManagement({ focusCreate: true })}
      />
      <TaskDialog
        form={taskForm}
        pending={createTaskMutation.isPending || updateTaskMutation.isPending}
        onChange={setTaskForm}
        onClose={() => setTaskForm(null)}
        onChooseProject={(initialPath) =>
          openWorkspacePicker({
            initialPath,
            onSelect: (projectPath) =>
              setTaskForm((current) =>
                current ? { ...current, projectPath } : current,
              ),
          })
        }
        onSubmit={submitTaskForm}
      />
    </main>
  )

  function setTaskFormFromTask(task: WorkflowTaskResponse) {
    setTaskForm({
      description: task.description,
      id: task.id,
      mode: "edit",
      projectPath: task.projectPath,
      status: task.status,
      title: task.title,
    })
  }
}

function ProjectRail({
  projects,
  selectedProjectPath,
  onCreateTask,
  onSelectProject,
}: {
  projects: WorkflowProject[]
  selectedProjectPath: string
  onCreateTask: () => void
  onSelectProject: (path: string) => void
}) {
  return (
    <aside className="hidden w-64 shrink-0 border-r bg-sidebar/60 md:flex md:flex-col">
      <div className="flex h-12 items-center justify-between gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <ClipboardList className="size-4 text-cyan-500" />
          <span className="truncate">Workflow</span>
        </div>
        <Button
          aria-label="New task"
          disabled={!selectedProjectPath}
          size="icon-sm"
          variant="ghost"
          onClick={onCreateTask}
        >
          <Plus />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid gap-1 p-2">
          {projects.map((project) => (
            <button
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent",
                project.path === selectedProjectPath &&
                  "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              key={project.key}
              title={project.path}
              type="button"
              onClick={() => onSelectProject(project.path)}
            >
              <Folder className="size-3.5 shrink-0 text-cyan-500" />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="shrink-0 text-[0.68rem] text-muted-foreground">
                {project.activeCount}/{project.count}
              </span>
            </button>
          ))}
          {!projects.length ? (
            <div className="px-2 py-3 text-sm text-muted-foreground">
              No project folders yet.
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  )
}

function WorkflowToolbar({
  project,
  projectPath,
  view,
  onChooseProject,
  onCreateTask,
  onViewChange,
}: {
  project: WorkflowProject | null
  projectPath: string
  view: WorkflowView
  onChooseProject: () => void
  onCreateTask: () => void
  onViewChange: (view: WorkflowView) => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">
          {project?.name ?? "Workflow"}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {projectPath || "Choose a project folder"}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant={view === "board" ? "secondary" : "ghost"}
          onClick={() => onViewChange("board")}
        >
          <Columns3 />
          Board
        </Button>
        <Button
          size="sm"
          variant={view === "list" ? "secondary" : "ghost"}
          onClick={() => onViewChange("list")}
        >
          <LayoutList />
          List
        </Button>
        <Button size="sm" variant="outline" onClick={onChooseProject}>
          <FolderOpen />
          Project
        </Button>
        <Button disabled={!projectPath} size="sm" onClick={onCreateTask}>
          <Plus />
          Task
        </Button>
      </div>
    </div>
  )
}

function WorkflowBoard(props: TaskCollectionProps) {
  return (
    <div className="grid min-w-0 gap-3 p-3 xl:grid-cols-4">
      {statuses.map((status) => {
        const columnTasks = props.tasks.filter((task) => task.status === status)
        return (
          <section
            className="min-h-48 min-w-0 rounded-lg border bg-muted/20"
            key={status}
          >
            <div className="flex h-10 items-center justify-between gap-2 border-b px-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn("size-2 rounded-full", statusDot(status))} />
                <span className="truncate text-sm font-medium">
                  {statusLabels[status]}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {columnTasks.length}
              </span>
            </div>
            <div className="grid gap-2 p-2">
              {columnTasks.map((task) => (
                <TaskCard key={task.id} task={task} {...props} />
              ))}
              {!columnTasks.length ? (
                <div className="rounded-md border border-dashed bg-background/55 px-3 py-6 text-center text-sm text-muted-foreground">
                  No tasks.
                </div>
              ) : null}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function WorkflowList(props: TaskCollectionProps) {
  return (
    <div className="grid gap-2 p-3">
      {props.tasks.map((task) => (
        <div
          className="grid min-w-0 gap-2 rounded-lg border bg-card px-3 py-2 md:grid-cols-[minmax(0,1fr)_150px_auto]"
          key={task.id}
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{task.title}</div>
            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {task.description || "No description."}
            </div>
          </div>
          <StatusSelect
            disabled={props.updatingTaskId === task.id}
            status={task.status}
            onChange={(status) => props.onStatusChange(task, status)}
          />
          <TaskActions task={task} {...props} />
        </div>
      ))}
      {!props.tasks.length ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No tasks in this project.
        </div>
      ) : null}
    </div>
  )
}

type TaskCollectionProps = {
  deletingTaskId: string | null
  executingTaskId: string | null
  tasks: WorkflowTaskResponse[]
  updatingTaskId: string | null
  onDelete: (task: WorkflowTaskResponse) => void
  onEdit: (task: WorkflowTaskResponse) => void
  onExecute: (task: WorkflowTaskResponse) => void
  onStatusChange: (task: WorkflowTaskResponse, status: WorkflowTaskStatus) => void
}

function TaskCard({
  deletingTaskId,
  executingTaskId,
  task,
  updatingTaskId,
  onDelete,
  onEdit,
  onExecute,
  onStatusChange,
}: TaskCollectionProps & { task: WorkflowTaskResponse }) {
  return (
    <article className="grid min-w-0 gap-2 rounded-md border bg-card p-3 shadow-sm">
      <div className="min-w-0">
        <div className="text-sm font-medium leading-5">{task.title}</div>
        <div className="mt-1 line-clamp-4 text-xs leading-5 text-muted-foreground">
          {task.description || "No description."}
        </div>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <StatusSelect
          disabled={updatingTaskId === task.id}
          status={task.status}
          onChange={(status) => onStatusChange(task, status)}
        />
        <TaskActions
          deletingTaskId={deletingTaskId}
          executingTaskId={executingTaskId}
          task={task}
          updatingTaskId={updatingTaskId}
          tasks={[]}
          onDelete={onDelete}
          onEdit={onEdit}
          onExecute={onExecute}
          onStatusChange={onStatusChange}
        />
      </div>
    </article>
  )
}

function TaskActions({
  deletingTaskId,
  executingTaskId,
  task,
  onDelete,
  onEdit,
  onExecute,
}: TaskCollectionProps & { task: WorkflowTaskResponse }) {
  const deleting = deletingTaskId === task.id
  const executing = executingTaskId === task.id
  return (
    <div className="flex shrink-0 items-center justify-end gap-1">
      <Button
        aria-label="Execute task"
        disabled={executing}
        size="icon-sm"
        title="Execute task"
        variant="ghost"
        onClick={() => onExecute(task)}
      >
        {executing ? <Loader2 className="animate-spin" /> : <Play />}
      </Button>
      <Button
        aria-label="Edit task"
        size="icon-sm"
        title="Edit task"
        variant="ghost"
        onClick={() => onEdit(task)}
      >
        <Pencil />
      </Button>
      <Button
        aria-label="Delete task"
        disabled={deleting}
        size="icon-sm"
        title="Delete task"
        variant="ghost"
        onClick={() => onDelete(task)}
      >
        {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </div>
  )
}

function StatusSelect({
  disabled,
  id,
  status,
  onChange,
}: {
  disabled?: boolean
  id?: string
  status: WorkflowTaskStatus
  onChange: (status: WorkflowTaskStatus) => void
}) {
  return (
    <select
      className={cn(
        "h-8 min-w-0 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        statusSelectClass(status),
      )}
      disabled={disabled}
      id={id}
      value={status}
      onChange={(event) => onChange(event.target.value as WorkflowTaskStatus)}
    >
      {statuses.map((entry) => (
        <option key={entry} value={entry}>
          {statusLabels[entry]}
        </option>
      ))}
    </select>
  )
}

function WorkflowAssistantPanel({
  account,
  lastOpenedChat,
  project,
  session,
  onAddAccount,
}: {
  account: AccountResponse | null
  lastOpenedChat: ChatResponse | null
  project: WorkflowProject | null
  session: {
    serverUrl: string
    token: string
  }
  onAddAccount: () => void
}) {
  const [prompt, setPrompt] = useState("")
  const [lastChat, setLastChat] = useState<ChatResponse | null>(null)
  const queryClient = useQueryClient()

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!account) {
        throw new Error("Connect an account before asking Codex.")
      }
      if (!project) {
        throw new Error("Choose a project before asking Codex.")
      }
      const chat = await createWorkflowChat({
        account,
        lastOpenedChat,
        projectPath: project.path,
        session,
        title: `Workflow: ${project.name}`,
      })
      const response = await executeChatMessage(session, chat.id, {
        content: workflowAssistantPrompt(project, prompt.trim()),
      })
      return { chat, response }
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: ({ chat, response }) => {
      setLastChat(chat)
      setPrompt("")
      queryClient.setQueryData<MessagePageResponse>(
        ["messages", chat.id],
        appendMessages(undefined, executeResponseMessages(response)),
      )
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      void queryClient.invalidateQueries({ queryKey: ["workflow-tasks"] })
    },
  })

  return (
    <aside className="hidden w-[400px] shrink-0 border-l bg-sidebar/40 lg:flex lg:flex-col">
      <div className="flex h-12 items-center justify-between gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <MessageSquarePlus className="size-4 text-emerald-500" />
          <span className="truncate">Codex Workflow</span>
        </div>
        {!account ? (
          <Button size="sm" variant="outline" onClick={onAddAccount}>
            Account
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="grid gap-3 p-3 text-sm">
            {lastChat ? (
              <div className="rounded-lg border bg-background/70 p-3">
                <div className="font-medium">{lastChat.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Codex is working in a chat thread. The board refreshes as MCP
                  tool calls update tasks.
                </div>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => window.open(`/chat/${lastChat.id}`, "_blank")}
                >
                  Open chat
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed bg-background/60 p-4 text-muted-foreground">
                Ask Codex to create, split, or update tasks for the selected
                project.
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      <div className="grid gap-2 border-t bg-background p-3">
        <Textarea
          className="min-h-24 resize-none"
          disabled={sendMutation.isPending}
          placeholder="Ask Codex to plan tasks"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              if (prompt.trim() && project && account && !sendMutation.isPending) {
                sendMutation.mutate()
              }
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {project?.path ?? "No project selected"}
          </div>
          <Button
            disabled={!prompt.trim() || !project || !account || sendMutation.isPending}
            onClick={() => sendMutation.mutate()}
          >
            {sendMutation.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <SendHorizontal />
            )}
            Send
          </Button>
        </div>
      </div>
    </aside>
  )
}

function TaskDialog({
  form,
  pending,
  onChange,
  onChooseProject,
  onClose,
  onSubmit,
}: {
  form: TaskFormState | null
  pending: boolean
  onChange: (form: TaskFormState | null) => void
  onChooseProject: (initialPath: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <Dialog
      open={!!form}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{form?.mode === "edit" ? "Edit task" : "Add task"}</DialogTitle>
          <DialogDescription>
            Keep the title short and put execution notes in the description.
          </DialogDescription>
        </DialogHeader>
        {form ? (
          <form className="grid gap-3" onSubmit={onSubmit}>
            <div className="grid gap-1.5">
              <label className="text-xs font-medium" htmlFor="task-title">
                Title
              </label>
              <Input
                id="task-title"
                value={form.title}
                onChange={(event) =>
                  onChange({ ...form, title: event.target.value })
                }
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs font-medium" htmlFor="task-project">
                Project
              </label>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  autoCapitalize="none"
                  className="min-w-0 font-mono text-xs"
                  id="task-project"
                  spellCheck={false}
                  value={form.projectPath}
                  onChange={(event) =>
                    onChange({ ...form, projectPath: event.target.value })
                  }
                />
                <Button
                  aria-label="Choose project"
                  size="icon"
                  type="button"
                  variant="outline"
                  onClick={() => onChooseProject(form.projectPath)}
                >
                  <FolderOpen />
                </Button>
              </div>
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs font-medium" htmlFor="task-status">
                Status
              </label>
              <StatusSelect
                id="task-status"
                status={form.status}
                onChange={(status) => onChange({ ...form, status })}
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs font-medium" htmlFor="task-description">
                Description
              </label>
              <Textarea
                className="min-h-32 resize-y"
                id="task-description"
                value={form.description}
                onChange={(event) =>
                  onChange({ ...form, description: event.target.value })
                }
              />
            </div>
            <DialogFooter>
              <Button disabled={pending} type="submit">
                {pending ? <Loader2 className="animate-spin" /> : <Plus />}
                Save
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

async function createWorkflowChat({
  account,
  lastOpenedChat,
  projectPath,
  session,
  title,
}: {
  account: AccountResponse
  lastOpenedChat: ChatResponse | null
  projectPath: string
  session: {
    serverUrl: string
    token: string
  }
  title: string
}) {
  return createChat(session, {
    accountId: account.id,
    autoRotateAccount: true,
    collaborationMode: "default",
    model: lastOpenedChat?.model ?? account.defaultModel ?? null,
    permissionMode:
      lastOpenedChat?.permissionMode ?? account.defaultPermissionMode ?? "default",
    reasoningEffort:
      lastOpenedChat?.reasoningEffort ?? account.defaultReasoningEffort ?? null,
    serviceTier: lastOpenedChat?.serviceTier ?? account.defaultServiceTier ?? null,
    title,
    workingDirectory: projectPath,
  })
}

function workflowAssistantPrompt(project: WorkflowProject, userPrompt: string): string {
  return [
    "Workflow task-board request.",
    `Project: ${project.name}`,
    `Project path: ${project.path}`,
    "Use the xedoc_workflow MCP tools when the request should create, split, update, delete, or inspect tasks.",
    "Allowed task statuses are pending, in_progress, finished, and failed.",
    "When creating tasks, make each title concrete and put execution guidance, acceptance criteria, and relevant notes in the description.",
    "User request:",
    userPrompt,
  ].join("\n\n")
}

function taskExecutionPrompt(task: WorkflowTaskResponse): string {
  return [
    "Execute this xedoc Workflow task.",
    `Task id: ${task.id}`,
    `Project path: ${task.projectPath}`,
    `Title: ${task.title}`,
    "Guidance:",
    task.description || "No additional guidance was provided.",
    "Use the xedoc_workflow MCP tools to set this task to finished when complete, or failed if it cannot be completed.",
  ].join("\n\n")
}

function buildProjects(
  tasks: WorkflowTaskResponse[],
  chats: ChatResponse[],
  lastOpenedChat: ChatResponse | null,
): WorkflowProject[] {
  const paths = new Set<string>()
  for (const task of tasks) {
    paths.add(task.projectPath)
  }
  for (const chat of chats) {
    const path = chat.workingDirectory?.trim()
    if (path) {
      paths.add(path)
    }
  }
  if (lastOpenedChat?.workingDirectory?.trim()) {
    paths.add(lastOpenedChat.workingDirectory.trim())
  }
  return [...paths]
    .map((path) => {
      const projectTasks = tasks.filter((task) => task.projectPath === path)
      return {
        activeCount: projectTasks.filter((task) => task.status !== "finished")
          .length,
        count: projectTasks.length,
        key: path,
        name: projectName(path),
        path,
      }
    })
    .sort(
      (left, right) =>
        right.activeCount - left.activeCount ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    )
}

function projectName(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean)
  return parts.at(-1) ?? path
}

function statusDot(status: WorkflowTaskStatus): string {
  switch (status) {
    case "in_progress":
      return "bg-cyan-500"
    case "finished":
      return "bg-emerald-500"
    case "failed":
      return "bg-rose-500"
    case "pending":
      return "bg-amber-500"
  }
}

function statusSelectClass(status: WorkflowTaskStatus): string {
  switch (status) {
    case "in_progress":
      return "border-cyan-500/40 text-cyan-700 dark:text-cyan-300"
    case "finished":
      return "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
    case "failed":
      return "border-rose-500/40 text-rose-700 dark:text-rose-300"
    case "pending":
      return "border-amber-500/40 text-amber-700 dark:text-amber-300"
  }
}
