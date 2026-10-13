import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC_EVENTS, IPC_REQUESTS, THEME_BOOTSTRAP_CHANNEL } from '../shared/ipc'
import type {
  AttachmentImageFile,
  BranchEntry,
  ChatAnswer,
  DiffStat,
  FilePreview,
  FileTreeNode,
  GitHubAccount,
  GitHubAddFlowProgress,
  GitStatusMap,
  LowMemoryWarning,
  MergeInput,
  OmpProviderState,
  PullRequestListResult,
  RefractApi,
  Readiness,
  ResolvedImage,
  Result,
  SessionSnapshot,
  SessionStatusEvent,
  SessionSummary,
  SlashCommand,
  SubmitReviewInput,
  TranscriptOp,
  Unsubscribe
} from '../shared/ipc'
import type { ImageContent, SideChatRecord } from '../shared/frames'
import type {
  CatalogKind,
  ConversationInfo,
  ModelCatalogEntry,
  ModelRoleId,
  PendingRequest,
  Repository,
  RepositoryRemote,
  Session,
  SessionReadout,
  Settings,
  SubagentSummary,
  TranscriptItem
} from '../shared/model'
import type { PullRequestDetail } from '../shared/github'
import type { ThemeId } from '../shared/themes'

// window.refract: the sole renderer-to-main bridge (contracts/ipc.md). The renderer never sees
// ipcRenderer or a raw channel string; every method below is a fixed, typed call.

// Every request channel answers with a Result<T>; main is trusted to shape it correctly, so the
// cast below is the one place that trust is spent.
function request<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>
}

// Every event channel is main-pushed, no-reply; wraps ipcRenderer.on/removeListener as a typed
// subscribe-and-forget with an unsubscribe function, per the Unsubscribe contract.
function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const refract: RefractApi = {
  readiness: {
    check: () => request<Readiness>(IPC_REQUESTS.READINESS_CHECK)
  },

  repositories: {
    list: () => request<Repository[]>(IPC_REQUESTS.REPOSITORIES_LIST),
    add: (path) => request<Repository>(IPC_REQUESTS.REPOSITORIES_ADD, path),
    remove: (id) => request<void>(IPC_REQUESTS.REPOSITORIES_REMOVE, id),
    rename: (id, name) => request<Repository>(IPC_REQUESTS.REPOSITORIES_RENAME, id, name),
    remotes: () => request<Record<string, RepositoryRemote>>(IPC_REQUESTS.REPOSITORIES_REMOTES),
    branches: (id) => request<BranchEntry[]>(IPC_REQUESTS.REPOSITORIES_BRANCHES, id),
    pickFolder: () => request<string | null>(IPC_REQUESTS.REPOSITORIES_PICK_FOLDER),
    userName: (id) => request<string>(IPC_REQUESTS.REPOSITORIES_USER_NAME, id)
  },

  sessions: {
    list: () => request<SessionSummary[]>(IPC_REQUESTS.SESSIONS_LIST),
    create: (input) => request<Session>(IPC_REQUESTS.SESSIONS_CREATE, input),
    rename: (id, name) => request<void>(IPC_REQUESTS.SESSIONS_RENAME, id, name),
    open: (id, userAction) => request<SessionSnapshot>(IPC_REQUESTS.SESSIONS_OPEN, id, userAction),
    archive: (id) => request<void>(IPC_REQUESTS.SESSIONS_ARCHIVE, id),
    restore: (id) => request<void>(IPC_REQUESTS.SESSIONS_RESTORE, id),
    deleteCheck: (id) =>
      request<{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }>(
        IPC_REQUESTS.SESSIONS_DELETE_CHECK,
        id
      ),
    delete: (id, options) => request<void>(IPC_REQUESTS.SESSIONS_DELETE, id, options),
    recreateWorktree: (id) => request<void>(IPC_REQUESTS.SESSIONS_RECREATE_WORKTREE, id),
    recover: (id) => request<SessionSnapshot>(IPC_REQUESTS.SESSIONS_RECOVER, id),
    resume: (id) => request<SessionSnapshot>(IPC_REQUESTS.SESSIONS_RESUME, id),
    stopAgent: (sessionId) => request<void>(IPC_REQUESTS.SESSIONS_STOP_AGENT, sessionId),
    keepWaitingForStart: (sessionId) => request<void>(IPC_REQUESTS.SESSIONS_KEEP_WAITING_FOR_START, sessionId),
    cancelStart: (sessionId) => request<void>(IPC_REQUESTS.SESSIONS_CANCEL_START, sessionId),
    setVisible: (sessionIds) => request<void>(IPC_REQUESTS.SESSIONS_SET_VISIBLE, sessionIds),
    diffStat: (id) => request<DiffStat | null>(IPC_REQUESTS.SESSIONS_DIFF_STAT, id),
    revealWorktree: (id) => request<void>(IPC_REQUESTS.SESSIONS_REVEAL_WORKTREE, id),
    revealFile: (sessionId, path) => request<void>(IPC_REQUESTS.SESSIONS_REVEAL_FILE, sessionId, path)
  },

  attachments: {
    readImageFile: (sessionId, path) => request<AttachmentImageFile>(IPC_REQUESTS.ATTACHMENTS_READ_IMAGE_FILE, sessionId, path),
    getPathForFile: (file) => webUtils.getPathForFile(file)
  },

  images: {
    get: (sessionId, imageId, mimeType, size) => request<ResolvedImage>(IPC_REQUESTS.IMAGES_GET, sessionId, imageId, mimeType, size)
  },

  clipboard: {
    writeText: (text) => request<void>(IPC_REQUESTS.CLIPBOARD_WRITE_TEXT, text)
  },

  conversations: {
    list: (sessionId) => request<ConversationInfo[]>(IPC_REQUESTS.CONVERSATIONS_LIST, sessionId),
    startNew: (sessionId) => request<SessionSnapshot>(IPC_REQUESTS.CONVERSATIONS_START_NEW, sessionId),
    open: (sessionId, file) => request<SessionSnapshot>(IPC_REQUESTS.CONVERSATIONS_OPEN, sessionId, file)
  },

  chat: {
    send: (sessionId, text, images?: ImageContent[]) =>
      request<{ queued: boolean }>(IPC_REQUESTS.CHAT_SEND, sessionId, text, images),
    stop: (sessionId) => request<void>(IPC_REQUESTS.CHAT_STOP, sessionId),
    removeQueued: (sessionId, text, queue) => request<{ removed: boolean }>(IPC_REQUESTS.CHAT_REMOVE_QUEUED, sessionId, text, queue),
    sendNow: (sessionId, text) => request<{ promoted: boolean }>(IPC_REQUESTS.CHAT_SEND_NOW, sessionId, text),
    answer: (sessionId, requestId, answer: ChatAnswer) =>
      request<void>(IPC_REQUESTS.CHAT_ANSWER, sessionId, requestId, answer),
    commands: (sessionId) => request<SlashCommand[]>(IPC_REQUESTS.CHAT_COMMANDS, sessionId),
    predictWord: (sessionId, text, cursor) =>
      request<string | null>(IPC_REQUESTS.CHAT_PREDICT_WORD, sessionId, text, cursor),
    predictWordFeedback: (sessionId, text, cursor, suggestion, accepted) =>
      request<void>(IPC_REQUESTS.CHAT_PREDICT_WORD_FEEDBACK, sessionId, text, cursor, suggestion, accepted),
    setVisibleSubagent: (sessionId, subagentId) =>
      request<void>(IPC_REQUESTS.CHAT_SET_VISIBLE_SUBAGENT, sessionId, subagentId),
    subagentSnapshot: (sessionId, subagentId) =>
      request<TranscriptItem[]>(IPC_REQUESTS.CHAT_SUBAGENT_SNAPSHOT, sessionId, subagentId)
  },

  sideChat: {
    ask: (sessionId, question, recordId?: string) =>
      request<{ record: SideChatRecord }>(IPC_REQUESTS.SIDE_CHAT_ASK, sessionId, question, recordId),
    cancel: (sessionId) => request<void>(IPC_REQUESTS.SIDE_CHAT_CANCEL, sessionId),
    getHistory: (sessionId) => request<SideChatRecord[]>(IPC_REQUESTS.SIDE_CHAT_GET_HISTORY, sessionId)
  },

  fileExplorer: {
    listDirectory: (sessionId, relativePath) =>
      request<{ entries: FileTreeNode[]; truncated: number }>(IPC_REQUESTS.FILE_EXPLORER_LIST_DIRECTORY, sessionId, relativePath),
    readPreview: (sessionId, relativePath) =>
      request<{ preview: FilePreview }>(IPC_REQUESTS.FILE_EXPLORER_READ_PREVIEW, sessionId, relativePath),
    getStatus: (sessionId) => request<{ status: GitStatusMap | null }>(IPC_REQUESTS.FILE_EXPLORER_GET_STATUS, sessionId),
    openInVSCode: (sessionId, relativePath) =>
      request<{ opened: boolean }>(IPC_REQUESTS.FILE_EXPLORER_OPEN_IN_VSCODE, sessionId, relativePath),
    reveal: (sessionId, relativePath) => request<void>(IPC_REQUESTS.FILE_EXPLORER_REVEAL, sessionId, relativePath),
    copyPath: (sessionId, relativePath) => request<void>(IPC_REQUESTS.FILE_EXPLORER_COPY_PATH, sessionId, relativePath),
    stopWatching: (sessionId) => request<void>(IPC_REQUESTS.FILE_EXPLORER_STOP_WATCHING, sessionId),
    ensureWatching: (sessionId) => request<void>(IPC_REQUESTS.FILE_EXPLORER_ENSURE_WATCHING, sessionId)
  },

  settings: {
    get: () => request<Settings>(IPC_REQUESTS.SETTINGS_GET),
    setApprovalMode: (mode) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_APPROVAL_MODE, mode),
    setReadoutVisibility: (kind, visible) =>
      request<Settings>(IPC_REQUESTS.SETTINGS_SET_READOUT_VISIBILITY, kind, visible),
    setSplit: (layout) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SPLIT, layout),
    setWatermarkEnabled: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_WATERMARK_ENABLED, enabled),
    setTranscriptDisplay: (field, visible) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_TRANSCRIPT_DISPLAY, field, visible),
    setShowSampleData: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SHOW_SAMPLE_DATA, enabled),
    setDetectImagePathsOnPaste: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_DETECT_IMAGE_PATHS_ON_PASTE, enabled)
  },

  modelRoles: {
    list: () => request<Record<string, string>>(IPC_REQUESTS.MODEL_ROLES_LIST),
    set: (role: ModelRoleId, value: string | null) =>
      request<{ roles: Record<string, string>; overriddenBy?: string }>(IPC_REQUESTS.MODEL_ROLES_SET, role, value),
    listCatalog: (kind: CatalogKind) => request<ModelCatalogEntry[]>(IPC_REQUESTS.MODEL_ROLES_LIST_CATALOG, kind)
  },

  window: {
    popupMenu: (menuId, x, y) => request<void>(IPC_REQUESTS.WINDOW_POPUP_MENU, menuId, x, y)
  },

  pullRequests: {
    list: (repositoryId, tab, query) => request<PullRequestListResult>(IPC_REQUESTS.PULL_REQUESTS_LIST, repositoryId, tab, query),
    detail: (repositoryId, number) => request<PullRequestDetail>(IPC_REQUESTS.PULL_REQUESTS_DETAIL, repositoryId, number),
    comment: (repositoryId, number, body) =>
      request<{ id: string }>(IPC_REQUESTS.PULL_REQUESTS_COMMENT, repositoryId, number, body),
    replyToThread: (repositoryId, number, threadId, body) =>
      request<{ id: string }>(IPC_REQUESTS.PULL_REQUESTS_REPLY_TO_THREAD, repositoryId, number, threadId, body),
    resolveThread: (repositoryId, number, threadId) =>
      request<void>(IPC_REQUESTS.PULL_REQUESTS_RESOLVE_THREAD, repositoryId, number, threadId),
    unresolveThread: (repositoryId, number, threadId) =>
      request<void>(IPC_REQUESTS.PULL_REQUESTS_UNRESOLVE_THREAD, repositoryId, number, threadId),
    submitReview: (repositoryId, number, input: SubmitReviewInput) =>
      request<{ id: string }>(IPC_REQUESTS.PULL_REQUESTS_SUBMIT_REVIEW, repositoryId, number, input),
    merge: (repositoryId, number, input: MergeInput) =>
      request<void>(IPC_REQUESTS.PULL_REQUESTS_MERGE, repositoryId, number, input),
    newSessionFromPullRequest: (repositoryId, number) =>
      request<Session>(IPC_REQUESTS.PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST, repositoryId, number)
  },

  theme: {
    preview: (themeId) => request<void>(IPC_REQUESTS.THEME_PREVIEW, themeId),
    set: (themeId) => request<Settings>(IPC_REQUESTS.THEME_SET, themeId)
  },

  // Synchronous by design (contracts/ipc.md "Bootstrap", research.md decision 4): called once
  // from `main.tsx`'s very first lines, before React mounts, so the renderer's single JS thread
  // blocks until the right theme class is already known -- see `theme:bootstrap`'s own handler
  // (`src/main/ipc/theme.ts`) for why this is the one channel in the app that is not
  // `Result<T>`-shaped.
  themeBootstrap: () => ipcRenderer.sendSync(THEME_BOOTSTRAP_CHANNEL) as { theme: ThemeId },

  accounts: {
    github: {
      list: () => request<GitHubAccount[]>(IPC_REQUESTS.ACCOUNTS_GITHUB_LIST),
      addStart: () => request<{ flowId: string }>(IPC_REQUESTS.ACCOUNTS_GITHUB_ADD_START),
      addCancel: (flowId) => request<void>(IPC_REQUESTS.ACCOUNTS_GITHUB_ADD_CANCEL, flowId),
      switch: (host, login) => request<GitHubAccount[]>(IPC_REQUESTS.ACCOUNTS_GITHUB_SWITCH, host, login),
      signOut: (host, login) => request<GitHubAccount[]>(IPC_REQUESTS.ACCOUNTS_GITHUB_SIGN_OUT, host, login)
    },
    omp: {
      list: () => request<OmpProviderState[]>(IPC_REQUESTS.ACCOUNTS_OMP_LIST),
      signIn: (providerId) => request<{ requestId: string | null }>(IPC_REQUESTS.ACCOUNTS_OMP_SIGN_IN, providerId),
      signOut: (providerId) => request<{ requestId: string | null }>(IPC_REQUESTS.ACCOUNTS_OMP_SIGN_OUT, providerId),
      answer: (requestId, answer) => request<void>(IPC_REQUESTS.ACCOUNTS_OMP_ANSWER, requestId, answer)
    }
  },

  app: {
    openReleaseNotes: () => request<void>(IPC_REQUESTS.APP_OPEN_RELEASE_NOTES)
  },
  onSessionStatus: (handler) => on<SessionStatusEvent>(IPC_EVENTS.SESSION_STATUS, handler),
  onSessionListChanged: (handler) => on<void>(IPC_EVENTS.SESSION_LIST_CHANGED, handler),
  onTranscriptPatch: (handler) => on<{ sessionId: string; ops: TranscriptOp[] }>(IPC_EVENTS.TRANSCRIPT_PATCH, handler),
  onQueueUpdate: (handler) =>
    on<{ sessionId: string; followUp: string[]; steering: string[] }>(IPC_EVENTS.QUEUE_UPDATE, handler),
  onRequestPending: (handler) =>
    on<{ sessionId: string; request: PendingRequest }>(IPC_EVENTS.REQUEST_PENDING, handler),
  onRequestResolved: (handler) => on<{ sessionId: string; requestId: string }>(IPC_EVENTS.REQUEST_RESOLVED, handler),
  onCommandsUpdate: (handler) =>
    on<{ sessionId: string; commands: SlashCommand[] }>(IPC_EVENTS.COMMANDS_UPDATE, handler),
  onSettingsChanged: (handler) => on<Settings>(IPC_EVENTS.SETTINGS_CHANGED, handler),
  onUiOpenSession: (handler) => on<{ sessionId: string }>(IPC_EVENTS.UI_OPEN_SESSION, handler),
  onMemoryWarning: (handler) => on<LowMemoryWarning>(IPC_EVENTS.MEMORY_WARNING, handler),
  onReadoutUpdate: (handler) => on<{ sessionId: string; readout: SessionReadout }>(IPC_EVENTS.READOUT_UPDATE, handler),
  onSubagentsUpdate: (handler) =>
    on<{ sessionId: string; subagents: SubagentSummary[] }>(IPC_EVENTS.SUBAGENTS_UPDATE, handler),
  onSubagentPatch: (handler) =>
    on<{ sessionId: string; subagentId: string; ops: TranscriptOp[] }>(IPC_EVENTS.SUBAGENT_PATCH, handler),
  onSideChatPatch: (handler) =>
    on<{ sessionId: string; delta?: string; recordId?: string; record?: SideChatRecord; notice?: string }>(IPC_EVENTS.SIDE_CHAT_PATCH, handler),
  onSideChatInterrupted: (handler) => on<{ sessionId: string }>(IPC_EVENTS.SIDE_CHAT_INTERRUPTED, handler),
  onSideChatConversationChanged: (handler) => on<{ sessionId: string }>(IPC_EVENTS.SIDE_CHAT_CONVERSATION_CHANGED, handler),
  onFileExplorerPatch: (handler) =>
    on<{ sessionId: string; relativePath: string; entries: FileTreeNode[]; truncated: number }>(IPC_EVENTS.FILE_EXPLORER_PATCH, handler),
  onFileExplorerReset: (handler) => on<{ sessionId: string }>(IPC_EVENTS.FILE_EXPLORER_RESET, handler),
  onAccountsGithubChanged: (handler) => on<GitHubAccount[]>(IPC_EVENTS.ACCOUNTS_GITHUB_CHANGED, handler),
  onAccountsGithubAddProgress: (handler) => on<GitHubAddFlowProgress>(IPC_EVENTS.ACCOUNTS_GITHUB_ADD_PROGRESS, handler)
}

contextBridge.exposeInMainWorld('refract', refract)

