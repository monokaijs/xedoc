import type {
  AccountResponse,
  AccountRuntimeSettingsRequest,
  ChatAttachmentInput,
  ChatEventPayloads,
  ChatEventType,
  ChatMessageResponse,
  ChatResponse,
  CodexCollaborationMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexServiceTier,
  ContextWindowUsagePayload,
  ExecuteChatRequest,
  MessagePageResponse,
} from "@/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Navigate, useParams } from "react-router"
import { toast } from "sonner"
import { TerminalDock } from "@/components/terminal-dock"
import { ActiveFileChangesPanel } from "@/components/timeline/file-change-block"
import {
  ChatComposerContextPanel,
  ChatTimeline,
  PinnedPlanTasksPanel,
  QueuedMessagesPanel,
  findPendingQueuedMessages,
  findPinnedProgressPlanMessage,
  findStickyChatContext,
  pinnedPlanMessageSignature,
} from "@/components/timeline/chat-timeline"
import type {
  FileChangePromptAction,
  ProposedPlanAction,
  ProposedPlanRevisionAction,
  QueuedMessageAction,
} from "@/components/timeline/chat-timeline"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  appendMessage,
  executeChatMessage,
  getChat,
  getChatContext,
  getChatMessages,
  interruptChatRun,
  listCodexModels,
  removeQueuedChatMessage,
  steerQueuedChatMessage,
  updateAccountRuntimeSettings,
  updateChat,
} from "@/lib/api"
import {
  applyChatEvent,
  highestSequence,
  mergeMessagePage,
} from "@/lib/chat-events"
import { playAgentSound } from "@/lib/agent-sounds"
import { connectChatEventSocket } from "@/lib/socket"
import { cn } from "@/lib/utils"
import { useShellContext } from "@/screens/shell-context"
import { CodexAccountSelector } from "@/screens/components/account-selector"
import {
  AttachmentTray,
  composerAttachmentsToRequest,
  fileAttachmentFromPath,
  imageAttachmentsFromFiles,
  imageFilesFromClipboard,
  type ComposerAttachment,
} from "@/screens/components/composer-attachments"
import {
  ChatInputPlanModeBadge,
  ChatRuntimeSelector,
  ComposerActionButton,
  ContextWindowPill,
  PermissionModeSelector,
  PlanModeSelector,
  UsageCapacityPill,
} from "@/screens/components/composer-controls"
import { GitPanel, GitStatusChip } from "@/screens/components/git-status"
import { HeaderTerminalButton } from "@/screens/components/header-menu"
import {
  appendMessages,
  autoRotateTargetAccountForChat,
  canSend,
  executeResponseMessages,
  isAccountTokenInvalidatedError,
  readError,
  selectBestAvailableAccount,
  selectedModelOption,
  upsertAccount,
} from "@/screens/chat-runtime-utils"

const IMPLEMENT_LATEST_PLAN_PROMPT =
  "Implement the latest approved plan from the most recent proposed plan in this thread."

function reviseLatestPlanPrompt(feedback: string) {
  return [
    "Revise the latest proposed plan from this thread using the following requested changes.",
    "Do not implement yet. Return an updated proposed plan.",
    "",
    feedback,
  ].join("\n")
}

const DEFAULT_GIT_PANEL_WIDTH = 360
const MIN_GIT_PANEL_WIDTH = 288
const MAX_GIT_PANEL_WIDTH = 720
const MAX_GIT_PANEL_VIEWPORT_RATIO = 0.55

function clampGitPanelWidth(width: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? MAX_GIT_PANEL_WIDTH
      : Math.max(
          MIN_GIT_PANEL_WIDTH,
          Math.min(
            MAX_GIT_PANEL_WIDTH,
            Math.round(window.innerWidth * MAX_GIT_PANEL_VIEWPORT_RATIO),
          ),
        )

  return Math.min(viewportMax, Math.max(MIN_GIT_PANEL_WIDTH, width))
}

export function ChatDetailPane() {
  const { chatId } = useParams()
  const {
    accounts,
    accountRateLimitFetching,
    accountRateLimitSnapshots,
    connectedAccounts,
    gitOpen,
    openWorkspacePicker,
    session,
    setActiveProjectPath,
    setGitOpen,
    setTerminalOpen,
    terminalCount,
    terminalOpen,
    terminalSocket,
    terminalSocketConnected,
  } = useShellContext()
  const [content, setContent] = useState("")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [olderMessagesPending, setOlderMessagesPending] = useState(false)
  const [contextWindowUsage, setContextWindowUsage] =
    useState<ContextWindowUsagePayload | null>(null)
  const [gitPanelWidth, setGitPanelWidth] = useState(DEFAULT_GIT_PANEL_WIDTH)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const stickToBottomRef = useRef(true)
  const isMobile = useIsMobile()
  const gitPanelWidthRef = useRef(DEFAULT_GIT_PANEL_WIDTH)
  const notifiedRunIdsRef = useRef(new Set<string>())
  const notifiedRequestIdsRef = useRef(new Set<string>())
  const queryClient = useQueryClient()
  const chatQueryKey = useMemo(() => ["chat", chatId] as const, [chatId])
  const messagesQueryKey = useMemo(
    () => ["messages", chatId] as const,
    [chatId],
  )

  useEffect(() => {
    setContextWindowUsage(null)
    setAttachments([])
    notifiedRunIdsRef.current.clear()
    notifiedRequestIdsRef.current.clear()
  }, [chatId])

  useEffect(() => {
    gitPanelWidthRef.current = gitPanelWidth
  }, [gitPanelWidth])

  useEffect(() => {
    const handleResize = () => {
      setGitPanelWidth((current) => {
        const nextWidth = clampGitPanelWidth(current)
        gitPanelWidthRef.current = nextWidth
        return nextWidth
      })
    }
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  const startGitPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const startX = event.clientX
      const startWidth = gitPanelWidth
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWidth = clampGitPanelWidth(
          startWidth + startX - moveEvent.clientX,
        )
        gitPanelWidthRef.current = nextWidth
        setGitPanelWidth(nextWidth)
      }
      const stopResize = () => {
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        document.removeEventListener("pointermove", handlePointerMove)
        document.removeEventListener("pointerup", stopResize)
      }
      document.addEventListener("pointermove", handlePointerMove)
      document.addEventListener("pointerup", stopResize)
    },
    [gitPanelWidth],
  )

  const chatQuery = useQuery({
    enabled: !!chatId,
    queryKey: chatQueryKey,
    queryFn: () => getChat(session, chatId!),
    refetchInterval: (query) =>
      query.state.data?.status === "RUNNING" ? 2_500 : false,
  })

  const messagesQuery = useQuery({
    enabled: !!chatId,
    queryKey: messagesQueryKey,
    queryFn: () => getChatMessages(session, chatId!),
    refetchInterval: () =>
      queryClient.getQueryData<ChatResponse>(chatQueryKey)?.status === "RUNNING"
        ? 2_500
        : false,
    structuralSharing: (previous, next) =>
      mergeMessagePage(
        previous as MessagePageResponse | undefined,
        next as MessagePageResponse,
      ),
  })
  const contextQuery = useQuery({
    enabled: !!chatId && !contextWindowUsage,
    queryKey: ["chat-context", chatId],
    queryFn: () => getChatContext(session, chatId!),
    retry: false,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (contextQuery.data?.usage && !contextWindowUsage) {
      setContextWindowUsage(contextQuery.data.usage)
    }
  }, [contextQuery.data?.usage, contextWindowUsage])
  const messages = useMemo(
    () => messagesQuery.data?.data ?? [],
    [messagesQuery.data],
  )
  const hasMoreMessagesBefore = messagesQuery.data?.hasMoreBefore ?? false
  const loadedChat = chatQuery.data
  useEffect(() => {
    if (!loadedChat) {
      return
    }
    queryClient.setQueryData<ChatResponse[] | undefined>(["chats"], (chats) =>
      chats?.map((chat) => (chat.id === loadedChat.id ? loadedChat : chat)),
    )
  }, [loadedChat, queryClient])
  const loadedAccount = accounts.find(
    (entry) => entry.id === loadedChat?.accountId,
  )
  const isRunning = loadedChat?.status === "RUNNING"
  const stickyChatContext = useMemo(
    () => findStickyChatContext(messages),
    [messages],
  )
  const pinnedPlanMessage = useMemo(
    () => findPinnedProgressPlanMessage(messages, isRunning),
    [isRunning, messages],
  )
  const pendingQueuedMessages = useMemo(
    () => findPendingQueuedMessages(messages),
    [messages],
  )
  const activeFileChangeMessages = useMemo(
    () => findActiveFileChangeMessages(messages, isRunning),
    [isRunning, messages],
  )
  const composerAccessoryVisible = !(
    terminalOpen && loadedChat?.workingDirectory
  )
  const hiddenTimelineMessageIds = useMemo(
    () =>
      [
        stickyChatContext.pendingRequest?.id,
        composerAccessoryVisible ? pinnedPlanMessage?.id : undefined,
        ...(composerAccessoryVisible
          ? pendingQueuedMessages.map((message) => message.id)
          : []),
        ...(composerAccessoryVisible
          ? activeFileChangeMessages.map((message) => message.id)
          : []),
      ].filter((id): id is string => !!id),
    [
      activeFileChangeMessages,
      composerAccessoryVisible,
      pendingQueuedMessages,
      pinnedPlanMessage?.id,
      stickyChatContext.pendingRequest?.id,
    ],
  )
  const pinnedPlanSignature = useMemo(
    () => pinnedPlanMessageSignature(pinnedPlanMessage),
    [pinnedPlanMessage],
  )
  const scrollSignature = useMemo(
    () =>
      messages
        .map(
          (message) =>
            `${message.id}:${message.sequence}:${message.status}:${message.content.length}`,
        )
        .join("|"),
    [messages],
  )

  useEffect(() => {
    setActiveProjectPath(loadedChat?.workingDirectory?.trim() ?? "")
    return () => setActiveProjectPath("")
  }, [loadedChat?.workingDirectory, setActiveProjectPath])

  const isNearScrollBottom = useCallback((element: HTMLDivElement) => {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 96
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = scrollViewportRef.current
    if (!element) {
      return
    }
    element.scrollTo({ behavior, top: element.scrollHeight })
  }, [])

  const loadEarlierMessages = useCallback(() => {
    if (
      !chatId ||
      olderMessagesPending ||
      !hasMoreMessagesBefore ||
      !messages.length
    ) {
      return
    }
    const beforeSequence = messages[0].sequence
    const viewport = scrollViewportRef.current
    const previousScrollHeight = viewport?.scrollHeight ?? 0
    stickToBottomRef.current = false
    setOlderMessagesPending(true)
    void getChatMessages(session, chatId, { beforeSequence })
      .then((next) => {
        queryClient.setQueryData<MessagePageResponse | undefined>(
          messagesQueryKey,
          (page) => mergeMessagePage(page, next),
        )
        requestAnimationFrame(() => {
          const currentViewport = scrollViewportRef.current
          if (!currentViewport) {
            return
          }
          currentViewport.scrollTop +=
            currentViewport.scrollHeight - previousScrollHeight
        })
      })
      .catch((caught) => toast.error(readError(caught)))
      .finally(() => setOlderMessagesPending(false))
  }, [
    chatId,
    hasMoreMessagesBefore,
    messages,
    messagesQueryKey,
    olderMessagesPending,
    queryClient,
    session,
  ])

  const modelsQuery = useQuery({
    enabled: !!loadedAccount?.id && loadedAccount.status === "CONNECTED",
    queryKey: ["models", loadedAccount?.id],
    queryFn: () => listCodexModels(session, loadedAccount!.id),
    staleTime: 5 * 60 * 1000,
  })
  useEffect(() => {
    if (isAccountTokenInvalidatedError(modelsQuery.error)) {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] })
    }
  }, [modelsQuery.error, queryClient])
  const rateLimitSnapshot = loadedAccount?.id
    ? accountRateLimitSnapshots[loadedAccount.id]
    : undefined
  const rateLimitPending = loadedAccount?.id
    ? !!accountRateLimitFetching[loadedAccount.id]
    : false

  const updateAccountMutation = useMutation({
    mutationFn: async (input: { accountId: string; notify?: boolean }) => {
      if (!chatId) {
        throw new Error("Chat is not available.")
      }
      return updateChat(session, chatId, { accountId: input.accountId })
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (chat, input) => {
      queryClient.setQueryData(["chat", chat.id], chat)
      queryClient.setQueryData<ChatResponse[] | undefined>(["chats"], (chats) =>
        chats?.map((entry) => (entry.id === chat.id ? chat : entry)),
      )
      if (input.notify !== false) {
        toast.success("Chat account updated.")
      }
    },
  })

  const updateRuntimeMutation = useMutation({
    mutationFn: (patch: {
      autoRotateAccount?: boolean
      collaborationMode?: CodexCollaborationMode | null
      model?: string | null
      permissionMode?: CodexPermissionMode | null
      reasoningEffort?: CodexReasoningEffort | null
      serviceTier?: CodexServiceTier | null
    }) => {
      if (!chatId) {
        throw new Error("Chat is not available.")
      }
      return updateChat(session, chatId, patch)
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (chat) => {
      queryClient.setQueryData(["chat", chat.id], chat)
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const updateAccountDefaultsMutation = useMutation({
    mutationFn: ({
      accountId,
      settings,
    }: {
      accountId: string
      settings: AccountRuntimeSettingsRequest
    }) => updateAccountRuntimeSettings(session, accountId, settings),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (account) => {
      queryClient.setQueryData<AccountResponse[] | undefined>(
        ["accounts"],
        (accounts) => upsertAccount(accounts, account),
      )
    },
  })

  const sendMutation = useMutation({
    mutationFn: (input?: {
      attachments?: ChatAttachmentInput[]
      clearComposer?: boolean
      collaborationMode?: CodexCollaborationMode | null
      content?: string
      delivery?: ExecuteChatRequest["delivery"]
      metadata?: Record<string, unknown>
    }) => {
      if (!chatId) {
        throw new Error("Chat is not available.")
      }
      const targetChatId = chatId
      return executeChatMessage(session, targetChatId, {
        attachments: input?.attachments,
        collaborationMode: input?.collaborationMode,
        content: (input?.content ?? content).trim(),
        delivery: input?.delivery,
        metadata: input?.metadata,
      }).then((response) => ({ chatId: targetChatId, response }))
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: ({ chatId: targetChatId, response }, input) => {
      if (targetChatId === chatId) {
        stickToBottomRef.current = true
      }
      if (targetChatId === chatId && (input?.clearComposer ?? true)) {
        setContent("")
        setAttachments([])
      }
      queryClient.setQueryData<MessagePageResponse | undefined>(
        ["messages", targetChatId],
        (page) => appendMessages(page, executeResponseMessages(response)),
      )
      void queryClient.invalidateQueries({ queryKey: ["chat", targetChatId] })
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const interruptMutation = useMutation({
    mutationFn: async () => {
      if (!chatId) {
        throw new Error("Chat is not available.")
      }
      const targetChatId = chatId
      return interruptChatRun(session, targetChatId).then((response) => ({
        chatId: targetChatId,
        response,
      }))
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: ({ chatId: targetChatId }) => {
      void queryClient.invalidateQueries({ queryKey: ["chat", targetChatId] })
      void queryClient.invalidateQueries({ queryKey: ["messages", targetChatId] })
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      toast.message("Task cancelled.")
    },
  })

  const steerQueuedMessageMutation = useMutation({
    mutationFn: async (action: QueuedMessageAction) => {
      if (!chatId) {
        throw new Error("Chat is not available.")
      }
      const targetChatId = chatId
      return steerQueuedChatMessage(session, targetChatId, action.queueId).then(
        (message) => ({ chatId: targetChatId, message }),
      )
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: ({ chatId: targetChatId, message }) => {
      queryClient.setQueryData<MessagePageResponse | undefined>(
        ["messages", targetChatId],
        (page) => appendMessage(page, message),
      )
      void queryClient.invalidateQueries({ queryKey: ["chat", targetChatId] })
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const removeQueuedMessageMutation = useMutation({
    mutationFn: async (action: QueuedMessageAction) => {
      if (!chatId) {
        throw new Error("Chat is not available.")
      }
      const targetChatId = chatId
      return removeQueuedChatMessage(session, targetChatId, action.queueId).then(
        (message) => ({ chatId: targetChatId, message }),
      )
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: ({ chatId: targetChatId, message }) => {
      queryClient.setQueryData<MessagePageResponse | undefined>(
        ["messages", targetChatId],
        (page) => appendMessage(page, message),
      )
      void queryClient.invalidateQueries({ queryKey: ["chat", targetChatId] })
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const bestAvailableAccount = useMemo(
    () =>
      selectBestAvailableAccount(connectedAccounts, accountRateLimitSnapshots),
    [accountRateLimitSnapshots, connectedAccounts],
  )
  const autoRotateTargetAccount = useMemo(
    () =>
      autoRotateTargetAccountForChat(
        loadedChat,
        loadedAccount,
        bestAvailableAccount,
        accountRateLimitSnapshots,
      ),
    [
      accountRateLimitSnapshots,
      bestAvailableAccount,
      loadedAccount,
      loadedChat,
    ],
  )
  const autoRotateTargetAccountId = autoRotateTargetAccount?.id

  useEffect(() => {
    if (
      !autoRotateTargetAccountId ||
      updateAccountMutation.isPending ||
      sendMutation.isPending
    ) {
      return
    }
    updateAccountMutation.mutate({
      accountId: autoRotateTargetAccountId,
      notify: false,
    })
  }, [
    autoRotateTargetAccountId,
    sendMutation.isPending,
    updateAccountMutation.isPending,
  ])

  const attachImages = useCallback((files: FileList | File[] | null) => {
    if (!files?.length) {
      return
    }
    void imageAttachmentsFromFiles(files)
      .then((nextAttachments) => {
        setAttachments((current) => [...current, ...nextAttachments])
      })
      .catch((caught) => toast.error(readError(caught)))
  }, [])

  const attachWorkspaceFile = useCallback(() => {
    openWorkspacePicker({
      initialPath: chatQuery.data?.workingDirectory,
      mode: "file",
      onSelect: (path) => {
        setAttachments((current) => [...current, fileAttachmentFromPath(path)])
      },
    })
  }, [chatQuery.data?.workingDirectory, openWorkspacePicker])

  const implementPlan = useCallback(
    (action: ProposedPlanAction) => {
      sendMutation.mutate({
        clearComposer: false,
        collaborationMode: "default",
        content: IMPLEMENT_LATEST_PLAN_PROMPT,
        metadata: {
          action: "implementPlan",
          planMessageId: action.message.id,
          source: "proposedPlan",
        },
      })
    },
    [sendMutation],
  )

  const revisePlan = useCallback(
    (action: ProposedPlanRevisionAction) => {
      sendMutation.mutate({
        clearComposer: false,
        collaborationMode: "plan",
        content: reviseLatestPlanPrompt(action.feedback),
        metadata: {
          action: "revisePlan",
          planMessageId: action.message.id,
          source: "proposedPlan",
        },
      })
    },
    [sendMutation],
  )

  const reviewFileChanges = useCallback(
    (action: FileChangePromptAction) => {
      sendMutation.mutate({
        clearComposer: false,
        collaborationMode: "default",
        content: action.prompt,
        metadata: {
          action: "reviewFileChanges",
          fileChangeMessageId: action.message.id,
          source: "fileChangeSummary",
        },
      })
    },
    [sendMutation],
  )

  const undoFileChanges = useCallback(
    (action: FileChangePromptAction) => {
      sendMutation.mutate({
        clearComposer: false,
        collaborationMode: "default",
        content: action.prompt,
        metadata: {
          action: "undoFileChanges",
          fileChangeMessageId: action.message.id,
          source: "fileChangeSummary",
        },
      })
    },
    [sendMutation],
  )

  useEffect(() => {
    if (!chatId) {
      return
    }

    const applyEvent = <TType extends ChatEventType>(
      type: TType,
      payload: ChatEventPayloads[TType],
    ) => {
      if (type === "run.status") {
        const runStatus = payload as ChatEventPayloads["run.status"]
        if (
          runStatus.status === "COMPLETED" &&
          !notifiedRunIdsRef.current.has(runStatus.runId)
        ) {
          notifiedRunIdsRef.current.add(runStatus.runId)
          playAgentSound("done")
        }
        return
      }
      if (type === "chat.updated") {
        const previousChat =
          queryClient.getQueryData<ChatResponse>(chatQueryKey)
        const updatedChat = payload as ChatResponse
        applyChatSnapshot(updatedChat)
        if (
          previousChat &&
          previousChat.lastActivityAt !== updatedChat.lastActivityAt
        ) {
          void queryClient.invalidateQueries({ queryKey: messagesQueryKey })
        }
        return
      }
      if (type === "context.updated") {
        setContextWindowUsage(payload as ContextWindowUsagePayload)
        return
      }
      if (type === "message.created" || type === "message.updated") {
        const message = payload as ChatMessageResponse
        const requestKey = message.requestId ?? message.id
        if (
          messageRequiresUserResponse(message) &&
          !notifiedRequestIdsRef.current.has(requestKey)
        ) {
          notifiedRequestIdsRef.current.add(requestKey)
          playAgentSound("question")
        }
      }
      queryClient.setQueryData<MessagePageResponse | undefined>(
        messagesQueryKey,
        (page) => applyChatEvent(page, type, payload),
      )
      if (type === "message.completed" || type === "message.failed") {
        void queryClient.invalidateQueries({ queryKey: messagesQueryKey })
        void queryClient.invalidateQueries({ queryKey: chatQueryKey })
        void queryClient.invalidateQueries({ queryKey: ["chats"] })
      }
    }

    return connectChatEventSocket(session, chatId, {
      onError: (caught) => toast.error(readError(caught)),
      onEvent: applyEvent,
      onOpen: () => {
        const currentPage =
          queryClient.getQueryData<MessagePageResponse>(messagesQueryKey)
        const afterSequence = highestSequence(currentPage)
        if (afterSequence <= 0) {
          return
        }
        void getChatMessages(session, chatId, { afterSequence })
          .then((next) => {
            queryClient.setQueryData<MessagePageResponse | undefined>(
              messagesQueryKey,
              (page) => mergeMessagePage(page, next),
            )
          })
          .catch((caught) => toast.error(readError(caught)))
      },
    })

    function applyChatSnapshot(updatedChat: ChatResponse) {
      queryClient.setQueryData<ChatResponse | undefined>(
        chatQueryKey,
        updatedChat,
      )
      queryClient.setQueryData<ChatResponse[] | undefined>(["chats"], (chats) =>
        chats?.map((chat) => (chat.id === updatedChat.id ? updatedChat : chat)),
      )
    }
  }, [chatId, chatQueryKey, messagesQueryKey, queryClient, session])

  useEffect(() => {
    stickToBottomRef.current = true
    const frame = requestAnimationFrame(() => scrollToBottom("auto"))
    return () => cancelAnimationFrame(frame)
  }, [chatId, scrollToBottom])

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return
    }
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      scrollToBottom("auto")
      secondFrame = requestAnimationFrame(() => scrollToBottom("auto"))
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [pinnedPlanSignature, scrollSignature, scrollToBottom])

  if (!chatId) {
    return <Navigate replace to="/" />
  }

  if (chatQuery.isLoading || messagesQuery.isLoading) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    )
  }

  if (chatQuery.error) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-6">
        <div className="max-w-md rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-medium">Chat not available</div>
          <div className="mt-1 whitespace-pre-wrap">
            {chatQuery.error.message}
          </div>
        </div>
      </main>
    )
  }

  const chat = loadedChat
  const account = loadedAccount
  const modelOptions = modelsQuery.data?.data ?? []
  const canSwitchAccount = !!chat && !isRunning && connectedAccounts.length > 0
  const selectedModel = selectedModelOption(modelOptions, chat?.model)
  const reasoningOptions =
    selectedModel?.supportedReasoningEfforts.map(
      (entry) => entry.reasoningEffort,
    ) ?? []
  const activeReasoningEffort =
    chat?.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? null
  const serviceTierOptions = selectedModel?.additionalSpeedTiers ?? []
  const composerHasDraft = content.trim().length > 0 || attachments.length > 0
  const composerCanSend = canSend(
    content,
    chat?.workingDirectory ?? "",
    account,
    attachments,
  )

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-b-xl bg-background",
            gitOpen && chat && "md:rounded-br-none",
          )}
        >
          <ScrollArea
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            viewportRef={scrollViewportRef}
            viewportProps={{
              className: "overflow-x-hidden",
              onScroll: (event) => {
                stickToBottomRef.current = isNearScrollBottom(
                  event.currentTarget,
                )
              },
            }}
          >
            <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 overflow-hidden px-4 pb-12 pt-6">
              {hasMoreMessagesBefore ? (
                <div className="flex justify-center">
                  <Button
                    disabled={olderMessagesPending}
                    size="sm"
                    variant="outline"
                    onClick={loadEarlierMessages}
                  >
                    {olderMessagesPending ? (
                      <>
                        <Loader2 className="size-3 animate-spin" />
                        Loading
                      </>
                    ) : (
                      "Load earlier"
                    )}
                  </Button>
                </div>
              ) : null}
              {messages.length ? (
                <ChatTimeline
                  chatId={chatId}
                  fileChangeActionDisabled={isRunning}
                  fileChangeActionPending={sendMutation.isPending}
                  hiddenMessageIds={hiddenTimelineMessageIds}
                  messages={messages}
                  onImplementPlan={implementPlan}
                  onRemoveQueuedMessage={(action) =>
                    removeQueuedMessageMutation.mutate(action)
                  }
                  onRevisePlan={revisePlan}
                  onReviewFileChanges={reviewFileChanges}
                  onSteerQueuedMessage={(action) =>
                    steerQueuedMessageMutation.mutate(action)
                  }
                  onUndoFileChanges={undoFileChanges}
                  planActionDisabled={isRunning}
                  planActionPending={sendMutation.isPending}
                  queuedMessageActionDisabled={
                    steerQueuedMessageMutation.isPending
                  }
                  queuedMessageActionPendingId={
                    steerQueuedMessageMutation.variables?.queueId ?? null
                  }
                  queuedMessageRemovePendingId={
                    removeQueuedMessageMutation.variables?.queueId ?? null
                  }
                  session={session}
                  showProcessingTail={
                    isRunning && !stickyChatContext.pendingRequest
                  }
                />
              ) : (
                <div className="py-20 text-center text-sm text-muted-foreground">
                  No messages yet.
                </div>
              )}
            </div>
          </ScrollArea>

          <div
            className={cn(
              "min-w-0 border-t bg-background",
              terminalOpen && chat?.workingDirectory
                ? "overflow-y-auto max-sm:max-h-[calc(100svh-3.5rem)]"
                : "overflow-hidden",
            )}
          >
            {terminalOpen && chat?.workingDirectory ? (
              <div className="p-2">
                <div className="mx-auto max-w-5xl">
                  <TerminalDock
                    onClosePanel={() => setTerminalOpen(false)}
                    projectPath={chat.workingDirectory}
                    socket={terminalSocket}
                    socketConnected={terminalSocketConnected}
                  />
                </div>
              </div>
            ) : (
              <>
                <PinnedPlanTasksPanel message={pinnedPlanMessage} />
                <QueuedMessagesPanel
                  disabled={steerQueuedMessageMutation.isPending}
                  messages={pendingQueuedMessages}
                  pendingQueueId={
                    steerQueuedMessageMutation.variables?.queueId ?? null
                  }
                  pendingRemoveQueueId={
                    removeQueuedMessageMutation.variables?.queueId ?? null
                  }
                  onRemoveQueuedMessage={(action) =>
                    removeQueuedMessageMutation.mutate(action)
                  }
                  onSteerQueuedMessage={(action) =>
                    steerQueuedMessageMutation.mutate(action)
                  }
                />
                <ActiveFileChangesPanel messages={activeFileChangeMessages} />
                <ChatComposerContextPanel
                  chatId={chatId}
                  messages={messages}
                  session={session}
                />
                <div className="p-2">
                  <div className="mx-auto grid min-w-0 max-w-3xl gap-2 overflow-hidden rounded-xl border bg-background p-2 shadow-sm">
                    <div className="relative min-w-0">
                      <ChatInputPlanModeBadge
                        visible={
                          (chat?.collaborationMode ?? "default") === "plan"
                        }
                      />
                      <Textarea
                        className={cn(
                          "max-h-32 min-h-12 bg-transparent! text-xs resize-none border-0 px-1 shadow-none focus-visible:ring-0",
                          (chat?.collaborationMode ?? "default") === "plan" &&
                            "pr-24",
                        )}
                        placeholder={
                          !chat?.workingDirectory
                            ? "Choose a directory first"
                            : account
                              ? "Message Codex"
                              : "Choose an account first"
                        }
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault()
                            if (composerCanSend) {
                              sendMutation.mutate({
                                attachments:
                                  composerAttachmentsToRequest(attachments),
                                clearComposer: true,
                                delivery: isRunning ? "queue" : undefined,
                              })
                            }
                          }
                        }}
                        onPaste={(event) => {
                          const files = imageFilesFromClipboard(
                            event.clipboardData,
                          )
                          if (files.length) {
                            attachImages(files)
                          }
                        }}
                      />
                    </div>
                    <AttachmentTray
                      attachments={attachments}
                      imageInputRef={imageInputRef}
                      onAttachImages={attachImages}
                      onRemove={(id) =>
                        setAttachments((current) =>
                          current.filter((attachment) => attachment.id !== id),
                        )
                      }
                    />
                    <div className="flex items-center justify-between gap-1 sm:gap-2">
                      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden sm:flex-wrap">
                        <PlanModeSelector
                          attachmentDisabled={sendMutation.isPending}
                          disabled={!chat}
                          modeDisabled={isRunning}
                          mode={chat?.collaborationMode ?? "default"}
                          onAttachFile={attachWorkspaceFile}
                          onAttachImage={() => imageInputRef.current?.click()}
                          pending={updateRuntimeMutation.isPending}
                          onSelectMode={(collaborationMode) =>
                            updateRuntimeMutation.mutate({ collaborationMode })
                          }
                        />
                        <CodexAccountSelector
                          account={account}
                          autoRotate={chat?.autoRotateAccount ?? false}
                          autoRotateDisabled={
                            !chat || isRunning || updateRuntimeMutation.isPending
                          }
                          connectedAccounts={connectedAccounts}
                          disabled={!chat || !connectedAccounts.length}
                          pending={updateAccountMutation.isPending}
                          selectedAccountId={chat?.accountId ?? ""}
                          selectionDisabled={!canSwitchAccount}
                          usageSnapshots={accountRateLimitSnapshots}
                          onAutoRotateChange={(autoRotateAccount) =>
                            updateRuntimeMutation.mutate({ autoRotateAccount })
                          }
                          onSelect={(accountId) =>
                            updateAccountMutation.mutate({ accountId })
                          }
                        />
                        <ChatRuntimeSelector
                          activeReasoningEffort={activeReasoningEffort}
                          disabled={!chat || isRunning || !account}
                          modelOptions={modelOptions}
                          modelValue={chat?.model ?? ""}
                          pending={
                            modelsQuery.isFetching ||
                            updateRuntimeMutation.isPending
                          }
                          reasoningOptions={reasoningOptions}
                          reasoningValue={chat?.reasoningEffort ?? ""}
                          selectedModel={selectedModel}
                          serviceTierOptions={serviceTierOptions}
                          serviceTierValue={chat?.serviceTier ?? ""}
                          onSelectModel={(model) => {
                            if (chat?.accountId) {
                              updateAccountDefaultsMutation.mutate({
                                accountId: chat.accountId,
                                settings: {
                                  defaultModel: model || null,
                                  defaultReasoningEffort: null,
                                  defaultServiceTier: null,
                                },
                              })
                            }
                            updateRuntimeMutation.mutate({
                              model: model || null,
                              reasoningEffort: null,
                              serviceTier: null,
                            })
                          }}
                          onSelectReasoning={(reasoningEffort) => {
                            const nextReasoningEffort = reasoningEffort
                              ? (reasoningEffort as CodexReasoningEffort)
                              : null
                            if (chat?.accountId) {
                              updateAccountDefaultsMutation.mutate({
                                accountId: chat.accountId,
                                settings: {
                                  defaultModel: chat.model ?? null,
                                  defaultReasoningEffort: nextReasoningEffort,
                                  defaultServiceTier: chat.serviceTier ?? null,
                                },
                              })
                            }
                            updateRuntimeMutation.mutate({
                              reasoningEffort: nextReasoningEffort,
                            })
                          }}
                          onSelectServiceTier={(serviceTier) => {
                            const nextServiceTier = serviceTier
                              ? (serviceTier as CodexServiceTier)
                              : null
                            if (chat?.accountId) {
                              updateAccountDefaultsMutation.mutate({
                                accountId: chat.accountId,
                                settings: {
                                  defaultModel: chat.model ?? null,
                                  defaultReasoningEffort:
                                    chat.reasoningEffort ?? null,
                                  defaultServiceTier: nextServiceTier,
                                },
                              })
                            }
                            updateRuntimeMutation.mutate({
                              serviceTier: nextServiceTier,
                            })
                          }}
                        />
                        <PermissionModeSelector
                          disabled={!chat}
                          mode={chat?.permissionMode ?? "default"}
                          pending={updateRuntimeMutation.isPending}
                          onSelectMode={(permissionMode) => {
                            if (chat?.accountId) {
                              updateAccountDefaultsMutation.mutate({
                                accountId: chat.accountId,
                                settings: {
                                  defaultPermissionMode: permissionMode,
                                },
                              })
                            }
                            updateRuntimeMutation.mutate({ permissionMode })
                          }}
                        />
                      </div>
                      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                        <ContextWindowPill usage={contextWindowUsage} />
                        <UsageCapacityPill
                          pending={rateLimitPending}
                          snapshot={rateLimitSnapshot}
                        />
                        <ComposerActionButton
                          loading={sendMutation.isPending}
                          running={isRunning}
                          hasDraft={composerHasDraft}
                          sendDisabled={!composerCanSend}
                          stopPending={interruptMutation.isPending}
                          onSend={() =>
                            sendMutation.mutate({
                              attachments:
                                composerAttachmentsToRequest(attachments),
                              clearComposer: true,
                              delivery: isRunning ? "queue" : undefined,
                            })
                          }
                          steerDisabled={
                            !isRunning ||
                            sendMutation.isPending ||
                            !composerCanSend
                          }
                          onSteer={() =>
                            sendMutation.mutate({
                              attachments:
                                composerAttachmentsToRequest(attachments),
                              clearComposer: true,
                              delivery: "steer",
                            })
                          }
                          onStop={() => interruptMutation.mutate()}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        {chat && gitOpen ? (
          <aside
            className="relative hidden min-h-0 shrink-0 border-l bg-background md:flex"
            style={{ width: gitPanelWidth }}
          >
            <button
              aria-label="Resize git panel"
              className="group absolute inset-y-0 left-0 z-20 flex w-3 -translate-x-1/2 cursor-col-resize items-center justify-center"
              type="button"
              onPointerDown={startGitPanelResize}
            >
              <span className="h-12 w-0.5 rounded-full bg-border transition-colors group-hover:bg-muted-foreground/70" />
            </button>
            <GitPanel
              chatId={chat.id}
              className="w-full"
              disabled={isRunning}
              session={session}
              onClose={() => setGitOpen(false)}
            />
          </aside>
        ) : null}
      </div>
      {chat && isMobile ? (
        <Sheet open={gitOpen} onOpenChange={setGitOpen}>
          <SheetContent
            className="w-[min(100vw,46rem)] max-w-none gap-0 p-0 md:hidden [&>button]:hidden"
            side="right"
          >
            <GitPanel
              chatId={chat.id}
              disabled={isRunning}
              session={session}
              onClose={() => setGitOpen(false)}
            />
          </SheetContent>
        </Sheet>
      ) : null}
      {chat ? (
        <div className="hidden min-h-9 shrink-0 items-center justify-end gap-1 bg-sidebar px-3 py-1 md:-mb-2 md:flex">
          <HeaderTerminalButton
            active={terminalOpen}
            className={cn(
              "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              terminalOpen
                ? "text-sidebar-accent-foreground"
                : "text-sidebar-foreground/75",
            )}
            count={terminalCount}
            disabled={!chat.workingDirectory?.trim()}
            onToggle={() => setTerminalOpen(!terminalOpen)}
          />
          <GitStatusChip
            active={gitOpen}
            chatId={chat.id}
            className="text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground"
            onToggle={() => setGitOpen(!gitOpen)}
            session={session}
          />
        </div>
      ) : null}
    </main>
  )
}

function messageRequiresUserResponse(message: ChatMessageResponse): boolean {
  return (
    message.status === "PENDING" &&
    (message.kind === "APPROVAL" || message.kind === "USER_INPUT_PROMPT")
  )
}

function findActiveFileChangeMessages(
  messages: ChatMessageResponse[],
  isRunning: boolean,
): ChatMessageResponse[] {
  if (!isRunning) {
    return []
  }
  const activeRunId = [...messages]
    .reverse()
    .find(
      (message) =>
        message.runId &&
        (message.status === "PENDING" || message.status === "STREAMING"),
    )?.runId
  if (!activeRunId) {
    return []
  }
  return messages
    .filter(
      (message) =>
        message.runId === activeRunId && message.kind === "FILE_CHANGE",
    )
    .sort((left, right) => left.sequence - right.sequence)
}
