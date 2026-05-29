import type {
  AccountResponse,
  AccountRuntimeSettingsRequest,
  CodexCollaborationMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  CodexServiceTier,
  MessagePageResponse,
} from "@/types"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen, UserRound } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { toast } from "sonner"
import { TerminalDock } from "@/components/terminal-dock"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  createChat,
  executeChatMessage,
  listCodexModels,
  updateAccountRuntimeSettings,
} from "@/lib/api"
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
  PermissionModeSelector,
  PlanModeSelector,
  UsageCapacityPill,
} from "@/screens/components/composer-controls"
import {
  appendMessages,
  canSend,
  executeResponseMessages,
  hasAvailableAccountSnapshot,
  isAccountTokenInvalidatedError,
  readError,
  routeWorkingDirectoryFromState,
  selectBestAvailableAccount,
  selectedModelOption,
  upsertAccount,
} from "@/screens/chat-runtime-utils"

export function NewChatPane() {
  const {
    accountRateLimitFetching,
    accountRateLimitSnapshots,
    accountUsageSummaries,
    connectedAccounts,
    lastOpenedChat,
    openAccountManagement,
    openWorkspacePicker,
    session,
    setActiveProjectPath,
    setTerminalOpen,
    terminalOpen,
    terminalSocket,
    terminalSocketConnected,
  } = useShellContext()
  const location = useLocation()
  const routeWorkingDirectory = routeWorkingDirectoryFromState(location.state)
  const routeWorkingDirectoryKey = routeWorkingDirectory
    ? `${location.key}:${routeWorkingDirectory}`
    : ""
  const [content, setContent] = useState("")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [collaborationMode, setCollaborationMode] =
    useState<CodexCollaborationMode>("default")
  const [model, setModel] = useState<string | null>(null)
  const [autoRotateAccount, setAutoRotateAccount] = useState(false)
  const [newChatAccountId, setNewChatAccountId] = useState<string | null>(null)
  const [permissionMode, setPermissionMode] =
    useState<CodexPermissionMode>("default")
  const [reasoningEffort, setReasoningEffort] =
    useState<CodexReasoningEffort | null>(null)
  const [runtimeAccountId, setRuntimeAccountId] = useState<string | null>(null)
  const [serviceTier, setServiceTier] = useState<CodexServiceTier | null>(null)
  const [workingDirectory, setWorkingDirectory] = useState(
    routeWorkingDirectory || lastOpenedChat?.workingDirectory?.trim() || "",
  )
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const seededLastOpenedChatIdRef = useRef<string | null>(
    lastOpenedChat?.id ?? null,
  )
  const appliedRouteWorkingDirectoryRef = useRef<string | null>(
    routeWorkingDirectoryKey || null,
  )

  useEffect(() => {
    setActiveProjectPath(workingDirectory.trim())
    return () => setActiveProjectPath("")
  }, [setActiveProjectPath, workingDirectory])

  useEffect(() => {
    if (
      !routeWorkingDirectory ||
      appliedRouteWorkingDirectoryRef.current === routeWorkingDirectoryKey
    ) {
      return
    }
    appliedRouteWorkingDirectoryRef.current = routeWorkingDirectoryKey
    setWorkingDirectory(routeWorkingDirectory)
  }, [routeWorkingDirectory, routeWorkingDirectoryKey])

  useEffect(() => {
    if (
      !lastOpenedChat ||
      seededLastOpenedChatIdRef.current === lastOpenedChat.id
    ) {
      return
    }

    seededLastOpenedChatIdRef.current = lastOpenedChat.id
    const nextWorkingDirectory = lastOpenedChat.workingDirectory?.trim() ?? ""
    if (nextWorkingDirectory) {
      setWorkingDirectory((current) =>
        current.trim() ? current : nextWorkingDirectory,
      )
    }
  }, [lastOpenedChat])

  const bestAvailableAccount = useMemo(
    () => selectBestAvailableAccount(connectedAccounts, accountRateLimitSnapshots),
    [accountRateLimitSnapshots, connectedAccounts],
  )
  const manuallySelectedAccount = connectedAccounts.find(
    (account) => account.id === newChatAccountId,
  )
  const quotaSelectionPending =
    connectedAccounts.some((account) => accountRateLimitFetching[account.id]) &&
    !hasAvailableAccountSnapshot(connectedAccounts, accountRateLimitSnapshots)
  const pendingSelectedAccount =
    connectedAccounts.find((account) => account.id === runtimeAccountId) ??
    connectedAccounts[0]
  const fallbackSelectedAccount = quotaSelectionPending
    ? pendingSelectedAccount
    : undefined
  const selectedConnectedAccount = autoRotateAccount
    ? bestAvailableAccount
    : manuallySelectedAccount ?? bestAvailableAccount ?? fallbackSelectedAccount
  const selectedConnectedAccountId = selectedConnectedAccount?.id ?? null

  useEffect(() => {
    if (!newChatAccountId) {
      return
    }
    if (!connectedAccounts.some((account) => account.id === newChatAccountId)) {
      setNewChatAccountId(null)
    }
  }, [connectedAccounts, newChatAccountId])

  useEffect(() => {
    if (!selectedConnectedAccount) {
      setRuntimeAccountId(null)
      setModel(null)
      setPermissionMode("default")
      setReasoningEffort(null)
      setServiceTier(null)
      return
    }
    setRuntimeAccountId(selectedConnectedAccount.id)
    setModel(selectedConnectedAccount.defaultModel ?? null)
    setPermissionMode(
      selectedConnectedAccount.defaultPermissionMode ?? "default",
    )
    setReasoningEffort(selectedConnectedAccount.defaultReasoningEffort ?? null)
    setServiceTier(selectedConnectedAccount.defaultServiceTier ?? null)
  }, [selectedConnectedAccountId])

  const modelsQuery = useQuery({
    enabled: !!selectedConnectedAccount?.id,
    queryKey: ["models", selectedConnectedAccount?.id],
    queryFn: () => listCodexModels(session, selectedConnectedAccount!.id),
    staleTime: 5 * 60 * 1000,
  })
  useEffect(() => {
    if (isAccountTokenInvalidatedError(modelsQuery.error)) {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] })
    }
  }, [modelsQuery.error, queryClient])
  const modelOptions = modelsQuery.data?.data ?? []
  const runtimeSelectionsApply =
    runtimeAccountId === selectedConnectedAccountId
  const effectiveModel = runtimeSelectionsApply ? model : null
  const effectiveReasoningEffort = runtimeSelectionsApply
    ? reasoningEffort
    : null
  const effectiveServiceTier = runtimeSelectionsApply ? serviceTier : null
  const selectedModel = selectedModelOption(modelOptions, effectiveModel)
  const reasoningOptions =
    selectedModel?.supportedReasoningEfforts.map(
      (entry) => entry.reasoningEffort,
    ) ?? []
  const activeReasoningEffort =
    effectiveReasoningEffort ?? selectedModel?.defaultReasoningEffort ?? null
  const serviceTierOptions = selectedModel?.additionalSpeedTiers ?? []
  const rateLimitSnapshot = selectedConnectedAccount
    ? accountRateLimitSnapshots[selectedConnectedAccount.id]
    : undefined
  const rateLimitPending = selectedConnectedAccount
    ? !!accountRateLimitFetching[selectedConnectedAccount.id]
    : false

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

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedConnectedAccount) {
        throw new Error("Connect an account before starting a chat.")
      }
      if (!workingDirectory.trim()) {
        throw new Error("Choose a working directory before starting a chat.")
      }
      const chat = await createChat(session, {
        accountId: selectedConnectedAccount.id,
        autoRotateAccount,
        collaborationMode,
        model: effectiveModel,
        permissionMode,
        reasoningEffort: effectiveReasoningEffort,
        serviceTier: effectiveServiceTier,
        workingDirectory: workingDirectory.trim(),
      })
      const response = await executeChatMessage(session, chat.id, {
        attachments: composerAttachmentsToRequest(attachments),
        content: content.trim(),
      })
      return { chat, response }
    },
    onError: (caught) => toast.error(readError(caught)),
    onSuccess: ({ chat, response }) => {
      setContent("")
      setAttachments([])
      setAutoRotateAccount(false)
      setCollaborationMode("default")
      setPermissionMode(
        selectedConnectedAccount?.defaultPermissionMode ?? "default",
      )
      setWorkingDirectory("")
      queryClient.setQueryData<MessagePageResponse>(
        ["messages", chat.id],
        appendMessages(undefined, executeResponseMessages(response)),
      )
      void queryClient.invalidateQueries({ queryKey: ["chats"] })
      navigate(`/chat/${chat.id}`)
    },
  })

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
      initialPath: workingDirectory,
      mode: "file",
      onSelect: (path) => {
        setAttachments((current) => [...current, fileAttachmentFromPath(path)])
      },
    })
  }, [openWorkspacePicker, workingDirectory])

  const terminalProjectPath = workingDirectory.trim()
  const showTerminalDock = terminalOpen && !!terminalProjectPath

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        viewportProps={{ className: "overflow-x-hidden" }}
      >
        <div
          className={cn(
            "mx-auto flex min-h-full w-full flex-col px-4",
            showTerminalDock
              ? "max-w-5xl justify-start py-4 sm:justify-center sm:py-8"
              : "max-w-[760px] justify-center py-8",
          )}
        >
          {!connectedAccounts.length ? (
            <div className="mb-4 rounded-md border bg-muted/35 p-4 text-sm">
              <div className="font-medium">No connected account</div>
              <div className="mt-1 text-muted-foreground">
                Create and authenticate a Codex account before starting a chat.
              </div>
              <Button
                className="mt-3"
                size="sm"
                onClick={() => openAccountManagement()}
              >
                <UserRound />
                Manage Accounts
              </Button>
            </div>
          ) : null}

          {showTerminalDock ? (
            <TerminalDock
              onClosePanel={() => setTerminalOpen(false)}
              projectPath={terminalProjectPath}
              socket={terminalSocket}
              socketConnected={terminalSocketConnected}
            />
          ) : (
            <div className="grid gap-3 rounded-2xl border bg-card/80 p-3 shadow-sm dark:border-border/90 dark:bg-card/55">
              <div className="flex min-w-0 items-center gap-2 rounded-xl border bg-transparent px-2 py-1.5 dark:bg-transparent">
                <Input
                  autoCapitalize="none"
                  className="h-8 min-w-0 border-0 bg-transparent px-1 font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
                  placeholder="Working directory"
                  spellCheck={false}
                  value={workingDirectory}
                  onChange={(event) => setWorkingDirectory(event.target.value)}
                />
                <Button
                  className="size-8 shrink-0"
                  size="icon"
                  title="Choose directory"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    openWorkspacePicker({
                      initialPath: workingDirectory,
                      onSelect: setWorkingDirectory,
                    })
                  }
                >
                  <FolderOpen />
                  <span className="sr-only">Choose directory</span>
                </Button>
              </div>
              <div className="relative min-w-0">
                <ChatInputPlanModeBadge
                  visible={collaborationMode === "plan"}
                />
                <Textarea
                  className={cn(
                    "min-h-32 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent",
                    collaborationMode === "plan" && "pr-24",
                  )}
                  placeholder="Message Codex"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault()
                      if (
                        !createMutation.isPending &&
                        canSend(
                          content,
                          workingDirectory,
                          selectedConnectedAccount,
                          attachments,
                        )
                      ) {
                        createMutation.mutate()
                      }
                    }
                  }}
                  onPaste={(event) => {
                    const files = imageFilesFromClipboard(event.clipboardData)
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
              <div className="flex items-center justify-between gap-1 sm:gap-3">
                <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-hidden sm:flex-wrap sm:gap-0">
                  <PlanModeSelector
                    attachmentDisabled={createMutation.isPending}
                    disabled={!selectedConnectedAccount}
                    mode={collaborationMode}
                    onAttachFile={attachWorkspaceFile}
                    onAttachImage={() => imageInputRef.current?.click()}
                    onSelectMode={setCollaborationMode}
                  />
                  <CodexAccountSelector
                    account={selectedConnectedAccount}
                    autoRotate={autoRotateAccount}
                    autoRotateDisabled={createMutation.isPending}
                    connectedAccounts={connectedAccounts}
                    disabled={!connectedAccounts.length}
                    selectedAccountId={selectedConnectedAccount?.id ?? ""}
                    usageSummaries={accountUsageSummaries}
                    onAutoRotateChange={setAutoRotateAccount}
                    onSelect={(accountId) => {
                      setAutoRotateAccount(false)
                      setNewChatAccountId(accountId)
                    }}
                  />
                  <ChatRuntimeSelector
                    activeReasoningEffort={activeReasoningEffort}
                    disabled={!selectedConnectedAccount}
                    modelOptions={modelOptions}
                    modelValue={effectiveModel ?? ""}
                    pending={modelsQuery.isFetching}
                    reasoningOptions={reasoningOptions}
                    reasoningValue={effectiveReasoningEffort ?? ""}
                    selectedModel={selectedModel}
                    serviceTierOptions={serviceTierOptions}
                    serviceTierValue={effectiveServiceTier ?? ""}
                    onSelectModel={(nextModel) => {
                      const accountId = selectedConnectedAccount?.id ?? null
                      setRuntimeAccountId(accountId)
                      setModel(nextModel || null)
                      setReasoningEffort(null)
                      setServiceTier(null)
                      if (accountId) {
                        updateAccountDefaultsMutation.mutate({
                          accountId,
                          settings: {
                            defaultModel: nextModel || null,
                            defaultReasoningEffort: null,
                            defaultServiceTier: null,
                          },
                        })
                      }
                    }}
                    onSelectReasoning={(nextEffort) => {
                      const accountId = selectedConnectedAccount?.id ?? null
                      const reasoningEffort = nextEffort
                        ? (nextEffort as CodexReasoningEffort)
                        : null
                      setRuntimeAccountId(accountId)
                      setReasoningEffort(reasoningEffort)
                      if (accountId) {
                        updateAccountDefaultsMutation.mutate({
                          accountId,
                          settings: {
                            defaultModel: effectiveModel,
                            defaultReasoningEffort: reasoningEffort,
                            defaultServiceTier: effectiveServiceTier,
                          },
                        })
                      }
                    }}
                    onSelectServiceTier={(nextTier) => {
                      const accountId = selectedConnectedAccount?.id ?? null
                      const serviceTier = nextTier
                        ? (nextTier as CodexServiceTier)
                        : null
                      setRuntimeAccountId(accountId)
                      setServiceTier(serviceTier)
                      if (accountId) {
                        updateAccountDefaultsMutation.mutate({
                          accountId,
                          settings: {
                            defaultModel: effectiveModel,
                            defaultReasoningEffort: effectiveReasoningEffort,
                            defaultServiceTier: serviceTier,
                          },
                        })
                      }
                    }}
                  />
                  <PermissionModeSelector
                    disabled={!selectedConnectedAccount}
                    mode={permissionMode}
                    onSelectMode={(nextPermissionMode) => {
                      setPermissionMode(nextPermissionMode)
                      if (selectedConnectedAccount?.id) {
                        updateAccountDefaultsMutation.mutate({
                          accountId: selectedConnectedAccount.id,
                          settings: {
                            defaultPermissionMode: nextPermissionMode,
                          },
                        })
                      }
                    }}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                  <UsageCapacityPill
                    pending={rateLimitPending}
                    snapshot={rateLimitSnapshot}
                  />
                  <ComposerActionButton
                    loading={createMutation.isPending}
                    sendDisabled={
                      !canSend(
                        content,
                        workingDirectory,
                        selectedConnectedAccount,
                        attachments,
                      )
                    }
                    onSend={() => createMutation.mutate()}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </main>
  )
}
