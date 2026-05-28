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
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  appendMessage,
  executeChatMessage,
  getChat,
  getChatContext,
  getChatMessages,
  interruptChatRun,
  listCodexModels,
  steerQueuedChatMessage,
  updateAccountRuntimeSettings,
  updateChat,
} from "@/lib/api"
import { applyChatEvent, mergeMessagePage } from "@/lib/chat-events"
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
import { GitStatusChip } from "@/screens/components/git-status"
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

export function ChatDetailPane() {
  const { chatId } = useParams()
  const {
    accounts,
    accountRateLimitFetching,
    accountRateLimitSnapshots,
    accountUsageSummaries,
    connectedAccounts,
    openWorkspacePicker,
    session,
    setActiveProjectPath,
    setTerminalOpen,
    terminalCount,
    terminalOpen,
    terminalSocket,
    terminalSocketConnected,
  } = useShellContext()
  const [content, setContent] = useState("")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [contextWindowUsage, setContextWindowUsage] =
    useState<ContextWindowUsagePayload | null>(null)
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const stickToBottomRef = useRef(true)
  const queryClient = useQueryClient()
  const chatQueryKey = useMemo(() => ["chat", chatId] as const, [chatId])
  const messagesQueryKey = useMemo(
    () => ["messages", chatId] as const,
    [chatId],
  )

  useEffect(() => {
    setContextWindowUsage(null)
    setAttachments([])
  }, [chatId])

  const chatQuery = useQuery({
    enabled: !!chatId,
    queryKey: chatQueryKey,
    queryFn: () => getChat(session, chatId!),
    refetchInterval: 2_500,
  })

  const messagesQuery = useQuery({
    enabled: !!chatId,
    queryKey: messagesQueryKey,
    queryFn: () => getChatMessages(session, chatId!, 0),
    refetchInterval: 2_500,
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
    mutationFn: (input: { accountId: string; notify?: boolean }) =>
      updateChat(session, chatId!, { accountId: input.accountId }),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (chat, input) => {
      queryClient.setQueryData(chatQueryKey, chat)
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
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
    }) => updateChat(session, chatId!, patch),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (chat) => {
      queryClient.setQueryData(chatQueryKey, chat)
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
    }) =>
      executeChatMessage(session, chatId!, {
        attachments: input?.attachments,
        collaborationMode: input?.collaborationMode,
        content: (input?.content ?? content).trim(),
        delivery: input?.delivery,
        metadata: input?.metadata,
      }),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (response, input) => {
      stickToBottomRef.current = true
      if (input?.clearComposer ?? true) {
        setContent("")
        setAttachments([])
      }
      queryClient.setQueryData<MessagePageResponse | undefined>(
        messagesQueryKey,
        (page) => appendMessages(page, executeResponseMessages(response)),
      )
      void queryClient.invalidateQueries({ queryKey: chatQueryKey })
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
    },
  })

  const interruptMutation = useMutation({
    mutationFn: () => interruptChatRun(session, chatId!),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatQueryKey })
      void queryClient.invalidateQueries({ queryKey: messagesQueryKey })
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      toast.message("Task cancelled.")
    },
  })

  const steerQueuedMessageMutation = useMutation({
    mutationFn: (action: QueuedMessageAction) =>
      steerQueuedChatMessage(session, chatId!, action.queueId),
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: (message) => {
      queryClient.setQueryData<MessagePageResponse | undefined>(
        messagesQueryKey,
        (page) => appendMessage(page, message),
      )
      void queryClient.invalidateQueries({ queryKey: chatQueryKey })
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
      if (type === "chat.updated") {
        applyChatSnapshot(payload as ChatResponse)
        return
      }
      if (type === "context.updated") {
        setContextWindowUsage(payload as ContextWindowUsagePayload)
        return
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
        void getChatMessages(session, chatId, 0)
          .then((next) => {
            queryClient.setQueryData<MessagePageResponse | undefined>(
              messagesQueryKey,
              (page) => mergeMessagePage(page, next),
            )
          })
          .catch((caught) => toast.error(readError(caught)))
        void getChat(session, chatId)
          .then(applyChatSnapshot)
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-b-xl bg-background">
        <ScrollArea
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
          viewportRef={scrollViewportRef}
          viewportProps={{
            className: "overflow-x-hidden",
            onScroll: (event) => {
              stickToBottomRef.current = isNearScrollBottom(event.currentTarget)
            },
          }}
        >
          <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 overflow-hidden px-4 pb-12 pt-6">
            {messages.length ? (
              <ChatTimeline
                chatId={chatId}
                fileChangeActionDisabled={isRunning}
                fileChangeActionPending={sendMutation.isPending}
                hiddenMessageIds={hiddenTimelineMessageIds}
                messages={messages}
                onImplementPlan={implementPlan}
                onRevisePlan={revisePlan}
                onReviewFileChanges={reviewFileChanges}
                onSteerQueuedMessage={(action) =>
                  steerQueuedMessageMutation.mutate(action)
                }
                onUndoFileChanges={undoFileChanges}
                planActionDisabled={isRunning}
                planActionPending={sendMutation.isPending}
                queuedMessageActionDisabled={
                  !isRunning || steerQueuedMessageMutation.isPending
                }
                queuedMessageActionPendingId={
                  steerQueuedMessageMutation.variables?.queueId ?? null
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
                disabled={!isRunning || steerQueuedMessageMutation.isPending}
                messages={pendingQueuedMessages}
                pendingQueueId={
                  steerQueuedMessageMutation.variables?.queueId ?? null
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
                        usageSummaries={accountUsageSummaries}
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
            chatId={chat.id}
            className="text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground"
            disabled={isRunning}
            session={session}
          />
        </div>
      ) : null}
    </main>
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
