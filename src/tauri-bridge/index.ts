// `window.refract`: the sole renderer-to-backend bridge for the Tauri/Rust build (FR-009), built
// over `@tauri-apps/api`'s `invoke`/`listen`. `entry.ts` assigns this to `window.refract` before
// importing the renderer's own entry point.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { IPC_EVENTS, IPC_REQUESTS } from '../shared/ipc'
import { chatPauseBridge } from './chatPause'
import { usageBridge } from './usage'
import type { AdvisorRoster, AdvisorRosterDetected } from '../shared/ipc-advisor-roster'
import type { CloneProgressEvent, CloneStartResult, GitHubRepoListing } from '../shared/ipc-repositories-clone'
import type { ClosedBranchesResult } from '../shared/ipc-home'
import type { GithubChangedPayload } from '../shared/ipc-github-changed'
import type { GhStackState } from '../shared/ipc-github-stack'
import type { CreatedIssue, IssueDetail, IssueLabel, IssueListResult, IssueMatch, SessionWithKickoff } from '../shared/ipc-issues'
import type { ItemCard, ItemSummary } from '../shared/ipc-item-refs'
import type { PullRequestAcrossResult } from '../shared/ipc-pull-requests'
import type { SessionActivity } from '../shared/activity'
import type {
  IpcErrorCode,
  BranchEntry,
  Check,
  ChatAnswer,
  DiffStat,
  FilePreview,
  FileTreeNode,
  GitStatusMap,
  GitChangesSnapshot,
  LeftoverSummary,
  LowMemoryWarning,
  TokenGuardCalls,
  AgentToolCall,
  TokenGuardHandoffResult,
  TokenGuardLaunchWarning,
  TokenGuardSnapshot,
  MergeInput,
  PullRequestListResult,
  RefractApi,
  Readiness,
  Result,
  SessionSnapshot,
  SessionStatusEvent,
  SessionSummary,
  SlashCommand,
  SubmitReviewInput,
  TranscriptOp,
  Unsubscribe
} from '../shared/ipc'
import type { AttachmentFileRead, AttachmentImageFile } from '../shared/ipc-attachments'
import type { SpellSuggestion } from '../shared/ipc-spellcheck'
import type { StopResult } from '../shared/stop-result'
import type { Model, RoleChangeSummary, ThinkingLevel } from '../shared/ipc-model'
import type { WorkingMode } from '../shared/workingMode'
import type { MessageImageData } from '../shared/ipc-images'
import type { CustomTheme, ThemeList } from '../shared/ipc-themes'
import type { DependencyInstallProgress, UpdateState } from '../shared/updates'
import type { GitHubAccount, GitHubAddFlowProgress, OmpProviderState } from '../shared/accounts'
import type { ImageContent, SideChatRecord } from '../shared/frames'
import type {
  Alarm,
  CatalogKind,
  ConversationInfo,
  ModelCatalogEntry,
  ModelRoleId,
  PendingRequest,
  Repository,
  RepositoryRemote,
  Session,
  SessionListCollapse,
  SessionReadout,
  Settings,
  SubagentSummary,
  TranscriptItem
} from '../shared/model'
import type { PullRequestDetail } from '../shared/github'
import type { ThemeId } from '../shared/themes'
import type { Typography } from '../shared/typography'

// Every request channel answers with a Result<T>; the Rust backend's `refract_request` command
// is trusted to shape it correctly, so the cast below is the one place that trust is spent.
function request<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return invoke<Result<T>>('refract_request', { channel, args })
}

// Every event channel is backend-pushed, no-reply. Tauri's `listen` is async (it returns a Promise
// for the unlisten function), so the subscription is pending for one microtask after this returns --
// `cancelled` below covers the (rare) case where the caller unsubscribes before that Promise
// settles, so the listener is torn down the instant it is ready rather than leaking.
function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  let unlisten: UnlistenFn | undefined
  let cancelled = false
  void listen<T>(channel, (event) => handler(event.payload)).then((fn) => {
    if (cancelled) {
      fn()
    } else {
      unlisten = fn
    }
  })
  return () => {
    cancelled = true
    unlisten?.()
    unlisten = undefined
  }
}

// Tauri's own native drag-drop handler (`getCurrentWebview().onDragDropEvent`), filtered to the
// `drop` variant only (issue #793, spike section 2): `enter`/`over`/`leave` are left to the DOM
// `dragenter`/`dragover`/`dragleave` handlers already in place (`ChatPane.tsx`), which still fire
// normally in WebView2. Same pending/cancelled shape as `on()` above.
function onFileDrop(handler: (event: { paths: string[]; position: { x: number; y: number } }) => void): Unsubscribe {
  let unlisten: UnlistenFn | undefined
  let cancelled = false
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return
      handler({ paths: event.payload.paths, position: { x: event.payload.position.x, y: event.payload.position.y } })
    })
    .then((fn) => {
      if (cancelled) {
        fn()
      } else {
        unlisten = fn
      }
    })
  return () => {
    cancelled = true
    unlisten?.()
    unlisten = undefined
  }
}

const refract: RefractApi = {
  readiness: {
    check: () => request<Readiness>(IPC_REQUESTS.READINESS_CHECK),
    checkStep: (step) => request<Check>(IPC_REQUESTS.READINESS_CHECK_STEP, step),
    installDependency: (dependency) => request<void>(IPC_REQUESTS.READINESS_INSTALL_DEPENDENCY, dependency)
  },

  repositories: {
    list: () => request<Repository[]>(IPC_REQUESTS.REPOSITORIES_LIST),
    add: (path) => request<Repository>(IPC_REQUESTS.REPOSITORIES_ADD, path),
    remove: (id) => request<void>(IPC_REQUESTS.REPOSITORIES_REMOVE, id),
    rename: (id, name) => request<Repository>(IPC_REQUESTS.REPOSITORIES_RENAME, id, name),
    setColor: (id, color) => request<Repository>(IPC_REQUESTS.REPOSITORIES_SET_COLOR, id, color),
    remotes: () => request<Record<string, RepositoryRemote>>(IPC_REQUESTS.REPOSITORIES_REMOTES),
    branches: (id) => request<BranchEntry[]>(IPC_REQUESTS.REPOSITORIES_BRANCHES, id),
    pickFolder: () => request<string | null>(IPC_REQUESTS.REPOSITORIES_PICK_FOLDER),
    userName: (id) => request<string>(IPC_REQUESTS.REPOSITORIES_USER_NAME, id),
    listGitHub: (owner) => request<GitHubRepoListing>(IPC_REQUESTS.REPOSITORIES_LIST_GITHUB, ...(owner === undefined ? [] : [owner])),
    clone: (cloneRequest) => request<CloneStartResult>(IPC_REQUESTS.REPOSITORIES_CLONE, cloneRequest),
    cloneCancel: (cloneId) => request<void>(IPC_REQUESTS.REPOSITORIES_CLONE_CANCEL, cloneId),
    onCloneProgress: (handler) => on<CloneProgressEvent>(IPC_EVENTS.REPOSITORIES_CLONE_PROGRESS, handler)
  },

  sessions: {
    list: () => request<SessionSummary[]>(IPC_REQUESTS.SESSIONS_LIST),
    create: (input) => request<Session>(IPC_REQUESTS.SESSIONS_CREATE, input),
    rename: (id, name) => request<void>(IPC_REQUESTS.SESSIONS_RENAME, id, name),
    open: (id, userAction) => request<SessionSnapshot>(IPC_REQUESTS.SESSIONS_OPEN, id, userAction),
    archive: (id) => request<void>(IPC_REQUESTS.SESSIONS_ARCHIVE, id),
    restore: (id) => request<void>(IPC_REQUESTS.SESSIONS_RESTORE, id),
    setHidden: (id, hidden) => request<void>(IPC_REQUESTS.SESSIONS_SET_HIDDEN, id, hidden),
    deleteCheck: (id) =>
      request<{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }>(
        IPC_REQUESTS.SESSIONS_DELETE_CHECK,
        id
      ),
    deleteLeftoverSummary: (id) =>
      request<LeftoverSummary>(IPC_REQUESTS.SESSIONS_DELETE_LEFTOVER_SUMMARY, id),
    delete: (id, options) => request<void>(IPC_REQUESTS.SESSIONS_DELETE, id, options),
    deleting: () => request<string[]>(IPC_REQUESTS.SESSIONS_DELETING),
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

  images: {
    get: (imageId) => request<MessageImageData>(IPC_REQUESTS.IMAGES_GET, imageId),
  },

  attachments: {
    readImageFile: (sessionId, path) => request<AttachmentImageFile>(IPC_REQUESTS.ATTACHMENTS_READ_IMAGE_FILE, sessionId, path),
    readFile: (sessionId, path) => request<AttachmentFileRead>(IPC_REQUESTS.ATTACHMENTS_READ_FILE, sessionId, path),
    pickFiles: (sessionId) => request<string[]>(IPC_REQUESTS.ATTACHMENTS_PICK_FILES, sessionId),
    recordDroppedPaths: (sessionId, paths) => request<void>(IPC_REQUESTS.ATTACHMENTS_RECORD_DROPPED_PATHS, sessionId, paths),
    // #432/#793: Tauri's own native drag-drop handler owns the drop (`dragDropEnabled` defaults
    // to `true`, left unset in `tauri.conf.json`'s window config -- spike section 2), so the
    // page's own HTML5 `drop` event never fires; `getPathForFile` has no Tauri equivalent either
    // (the standard `File` API never exposes an OS path), so neither is implemented here --
    // `onFileDrop` is the real replacement, real absolute OS paths, not a stub.
    onFileDrop
  },

  clipboard: {
    writeText: (text) => request<void>(IPC_REQUESTS.CLIPBOARD_WRITE_TEXT, text),
    readText: () => request<string>(IPC_REQUESTS.CLIPBOARD_READ_TEXT),
    writeImage: (pngBase64) => request<void>(IPC_REQUESTS.CLIPBOARD_WRITE_IMAGE, pngBase64),
    saveImage: (pngBase64, suggestedName) => request<string | null>(IPC_REQUESTS.CLIPBOARD_SAVE_IMAGE, pngBase64, suggestedName)
  },

  advisorRoster: {
    detect: (sessionId) => request<AdvisorRoster | null>(IPC_REQUESTS.ADVISOR_ROSTER_DETECT, sessionId),
    open: (sessionId) => request<void>(IPC_REQUESTS.ADVISOR_ROSTER_OPEN, sessionId)
  },

  spellcheck: {
    suggest: (word, language) => request<SpellSuggestion>(IPC_REQUESTS.SPELLCHECK_SUGGEST, word, language),
    add: (word, language) => request<void>(IPC_REQUESTS.SPELLCHECK_ADD, word, language)
  },

  conversations: {
    list: (sessionId) => request<ConversationInfo[]>(IPC_REQUESTS.CONVERSATIONS_LIST, sessionId),
    startNew: (sessionId) => request<SessionSnapshot>(IPC_REQUESTS.CONVERSATIONS_START_NEW, sessionId),
    open: (sessionId, file) => request<SessionSnapshot>(IPC_REQUESTS.CONVERSATIONS_OPEN, sessionId, file)
  },

  chat: {
    send: (sessionId, text, images?: ImageContent[]) =>
      request<{ queued: boolean }>(IPC_REQUESTS.CHAT_SEND, sessionId, text, images),
    stop: (sessionId) => request<StopResult>(IPC_REQUESTS.CHAT_STOP, sessionId),
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
      request<TranscriptItem[]>(IPC_REQUESTS.CHAT_SUBAGENT_SNAPSHOT, sessionId, subagentId),
    ...chatPauseBridge(request)
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

  // Spec 018 slice 1 (issue #464): was missing from this bridge entirely (the Rust dispatcher,
  // `shared/ipc.ts`'s `RefractApi` contract, and the renderer store all already assumed this
  // existed) -- added here, same `request`/channel-constant pattern as `fileExplorer` above.
  gitChanges: {
    list: (sessionId) => request<{ snapshot: GitChangesSnapshot | null }>(IPC_REQUESTS.GIT_CHANGES_LIST, sessionId),
    stage: (sessionId, paths) => request<void>(IPC_REQUESTS.GIT_CHANGES_STAGE, sessionId, paths),
    unstage: (sessionId, paths) => request<void>(IPC_REQUESTS.GIT_CHANGES_UNSTAGE, sessionId, paths),
    stageAll: (sessionId, group) => request<void>(IPC_REQUESTS.GIT_CHANGES_STAGE_ALL, sessionId, group),
    unstageAll: (sessionId) => request<void>(IPC_REQUESTS.GIT_CHANGES_UNSTAGE_ALL, sessionId),
    diff: (sessionId, path, staged, untracked) => request<{ patch: string; reason: string | null }>(IPC_REQUESTS.GIT_CHANGES_DIFF, sessionId, path, staged, untracked),
    commit: (sessionId, message) => request<void>(IPC_REQUESTS.GIT_CHANGES_COMMIT, sessionId, message),
    stopWatching: (sessionId) => request<void>(IPC_REQUESTS.GIT_CHANGES_STOP_WATCHING, sessionId),
    ensureWatching: (sessionId) => request<void>(IPC_REQUESTS.GIT_CHANGES_ENSURE_WATCHING, sessionId)
  },
  agentTools: {
    result: (sessionId, callId, reply) => request<void>(IPC_REQUESTS.AGENT_TOOLS_RESULT, sessionId, callId, reply),
    started: (sessionId, callId) => request<{ accepted: boolean }>(IPC_REQUESTS.AGENT_TOOLS_STARTED, sessionId, callId)
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
    setDetectImagePathsOnPaste: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_DETECT_IMAGE_PATHS_ON_PASTE, enabled),
    setShowContextUsageBar: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SHOW_CONTEXT_USAGE_BAR, enabled),
    setShowAiCredits: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SHOW_AI_CREDITS, enabled),
    setShowAgentStoppedBar: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SHOW_AGENT_STOPPED_BAR, enabled),
    setAnimatedStatusText: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_ANIMATED_STATUS_TEXT, enabled),
    setCodeLigatures: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_CODE_LIGATURES, enabled),
    setShowScrollbarMap: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SHOW_SCROLLBAR_MAP, enabled),
    setStackedPullRequests: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_STACKED_PULL_REQUESTS, enabled),
    setTypography: (value) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_TYPOGRAPHY, value),
    upsertAlarm: (alarm) => request<Settings>(IPC_REQUESTS.SETTINGS_UPSERT_ALARM, alarm),
    deleteAlarm: (id) => request<Settings>(IPC_REQUESTS.SETTINGS_DELETE_ALARM, id),
    setShowFinishedTurnTimes: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SHOW_FINISHED_TURN_TIMES, enabled),
    setSessionNotificationSounds: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SESSION_NOTIFICATION_SOUNDS, enabled),
    setAlarmSounds: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_ALARM_SOUNDS, enabled),
    setSessionListCollapse: (value) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_SESSION_LIST_COLLAPSE, value),
    // Issue #772, lane R6: Rust-only, see `IPC_REQUESTS.SETTINGS_SET_WORD_PREDICTION_ENABLED`'s
    // own doc comment.
    setWordPredictionEnabled: (enabled) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_WORD_PREDICTION_ENABLED, enabled),
    setRightPane: (value) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_RIGHT_PANE, value),
    setPullRequestsListWidth: (widthPx) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_PULL_REQUESTS_LIST_WIDTH, widthPx),
    setChatWidth: (width) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_CHAT_WIDTH, width),
    setHolidayTouches: (value) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_HOLIDAY_TOUCHES, value),
    setActivityText: (value) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_ACTIVITY_TEXT, value),
    setStatusStyle: (value) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_STATUS_STYLE, value),
    setChatRowDensity: (value) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_CHAT_ROW_DENSITY, value),
    setDefaultCloneFolder: (path) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_DEFAULT_CLONE_FOLDER, path)
  },

  debug: {
    getOverrides: () => request<{ date: string | null; idleTimeoutMs: number | null; flightIntervalMs: number | null }>(IPC_REQUESTS.DEBUG_GET_OVERRIDES)
  },

  modelRoles: {
    list: () => request<Record<string, string>>(IPC_REQUESTS.MODEL_ROLES_LIST),
    set: (role: ModelRoleId, value: string | null) =>
      request<{ roles: Record<string, string>; overriddenBy?: string; propagation?: RoleChangeSummary }>(IPC_REQUESTS.MODEL_ROLES_SET, role, value),
    listCatalog: (kind: CatalogKind) => request<ModelCatalogEntry[]>(IPC_REQUESTS.MODEL_ROLES_LIST_CATALOG, kind)
  },

  // Lane RM (#454, #740, #741, #762, #766): per-Session model/role actions (`ipc-model.ts`'s
  // own `ModelApi` has the full reasoning).
  model: {
    setModel: (sessionId: string, provider: string, modelId: string) =>
      request<{ model: Model }>(IPC_REQUESTS.MODEL_SET_MODEL, sessionId, provider, modelId),
    cycleModel: (sessionId: string) => request<{ model: Model }>(IPC_REQUESTS.MODEL_CYCLE_MODEL, sessionId),
    applyRole: (sessionId: string, role: string) =>
      request<{ model: Model; role: string }>(IPC_REQUESTS.MODEL_APPLY_ROLE, sessionId, role),
    listRoles: (sessionId: string) =>
      request<{ roles: Array<{ role: string; model: string | null; current: boolean }>; currentRole: string | null; pinned: boolean }>(
        IPC_REQUESTS.MODEL_LIST_ROLES,
        sessionId
      ),
    setThinkingLevel: (sessionId: string, level: ThinkingLevel) =>
      request<{ thinkingLevel: string | null }>(IPC_REQUESTS.MODEL_SET_THINKING_LEVEL, sessionId, level)
  },

  workingMode: {
    set: (sessionId: string, mode: WorkingMode) =>
      request<{ mode: WorkingMode; pending?: boolean }>(IPC_REQUESTS.WORKING_MODE_SET, sessionId, mode)
  },

  window: {
    popupMenu: (menuId, x, y) => request<void>(IPC_REQUESTS.WINDOW_POPUP_MENU, menuId, x, y),
    zoom: (action) => request<void>(IPC_REQUESTS.WINDOW_ZOOM, action)
  },

  issues: {
    labels: (repositoryId) => request<IssueLabel[]>(IPC_REQUESTS.ISSUES_LABELS, repositoryId),
    search: (repositoryId, query) => request<IssueMatch[]>(IPC_REQUESTS.ISSUES_SEARCH, repositoryId, query),
    create: (repositoryId, title, body, labels) =>
      request<CreatedIssue>(IPC_REQUESTS.ISSUES_CREATE, repositoryId, title, body, labels),
    list: (tab, state, repositoryIds, label, query) =>
      request<IssueListResult>(IPC_REQUESTS.ISSUES_LIST, tab, state, repositoryIds, label, query),
    view: (repositoryId, number) => request<IssueDetail>(IPC_REQUESTS.ISSUES_VIEW, repositoryId, number),
    newSession: (repositoryId, number) =>
      request<SessionWithKickoff>(IPC_REQUESTS.ISSUES_NEW_SESSION, repositoryId, number)
  },
  itemRefs: {
    lookup: (repositoryId, owner, repo, number) => request<ItemCard>(IPC_REQUESTS.ITEM_REFS_LOOKUP, repositoryId, owner, repo, number),
    search: (repositoryId, query) => request<ItemSummary[]>(IPC_REQUESTS.ITEM_REFS_SEARCH, repositoryId, query)
  },

  home: {
    lastMessages: (sessionIds) => request<Record<string, string | null>>(IPC_REQUESTS.HOME_LAST_MESSAGES, sessionIds),
    closedBranches: (repositoryIds) => request<ClosedBranchesResult>(IPC_REQUESTS.HOME_CLOSED_BRANCHES, repositoryIds)
  },
  pullRequests: {
    list: (repositoryId, tab, state, query) => request<PullRequestListResult>(IPC_REQUESTS.PULL_REQUESTS_LIST, repositoryId, tab, state, query),
    listAcross: (tab, state, repositoryIds, query, limit) =>
      request<PullRequestAcrossResult>(IPC_REQUESTS.PULL_REQUESTS_LIST_ACROSS, tab, state, repositoryIds, query, limit),
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
    close: (repositoryId, number) => request<Record<string, never>>(IPC_REQUESTS.PULL_REQUESTS_CLOSE, repositoryId, number),
    fetchImage: (url) => request<{ dataUrl: string }>(IPC_REQUESTS.PULL_REQUESTS_FETCH_IMAGE, url),
    newSessionFromPullRequest: (repositoryId, number) =>
      request<SessionWithKickoff>(IPC_REQUESTS.PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST, repositoryId, number)
  },

  githubStack: {
    state: () => request<GhStackState>(IPC_REQUESTS.GITHUB_STACK_STATE),
    install: () => request<GhStackState>(IPC_REQUESTS.GITHUB_STACK_INSTALL)
  },

  theme: {
    set: (themeId) => request<Settings>(IPC_REQUESTS.THEME_SET, themeId)
  },
  themes: {
    list: () => request<ThemeList>(IPC_REQUESTS.THEMES_LIST),
    import: () => request<CustomTheme | null>(IPC_REQUESTS.THEMES_IMPORT),
    export: (suggestedName, json) => request<string | null>(IPC_REQUESTS.THEMES_EXPORT, suggestedName, json),
    remove: (id) => request<null>(IPC_REQUESTS.THEMES_REMOVE, id),
    openFolder: (id) => request<null>(IPC_REQUESTS.THEMES_OPEN_FOLDER, ...(id === undefined ? [] : [id])),
    setCustom: (id) => request<Settings>(IPC_REQUESTS.THEME_SET_CUSTOM, id)
  },

  tokenGuard: {
    get: (repositoryId) => request<TokenGuardSnapshot>(IPC_REQUESTS.TOKEN_GUARD_GET, { repositoryId }),
    set: (key, value, repositoryId) => request<TokenGuardSnapshot>(IPC_REQUESTS.TOKEN_GUARD_SET, { key, value, repositoryId }),
    reset: (key, repositoryId) => request<TokenGuardSnapshot>(IPC_REQUESTS.TOKEN_GUARD_RESET, { key, repositoryId }),
    resetAll: (repositoryId) => request<TokenGuardSnapshot>(IPC_REQUESTS.TOKEN_GUARD_RESET_ALL, { repositoryId }),
    dismissMigrationNotice: () => request<null>(IPC_REQUESTS.TOKEN_GUARD_DISMISS_THRESHOLDS_RESET),
    handoff: (sessionId) =>
      request<TokenGuardHandoffResult>(IPC_REQUESTS.TOKEN_GUARD_HANDOFF, sessionId)
  },

  copilot: {
    planUsage: () => request<{ percentUsed: number } | null>(IPC_REQUESTS.COPILOT_PLAN_USAGE)
  },

  // Synchronous by design (FR-011, research.md decision 4): called once from `main.tsx`'s very
  // first lines, before React mounts, so the renderer's single JS thread blocks until the right
  // theme class is already known. Reads `window.__REFRACT_THEME_BOOTSTRAP__`, set by an
  // initialization script `lib.rs`'s `setup` hook registers BEFORE the window ever loads a page
  // (FR-010) -- no IPC round trip.
  themeBootstrap: () => window.__REFRACT_THEME_BOOTSTRAP__ ?? { theme: 'dark' },

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
    openReleaseNotes: () => request<void>(IPC_REQUESTS.APP_OPEN_RELEASE_NOTES),
    getVersion: () => request<string>(IPC_REQUESTS.APP_GET_VERSION)
  },

  usage: usageBridge(request, on),

  updates: {
    check: () => request<UpdateState>(IPC_REQUESTS.UPDATES_CHECK),
    getState: () => request<UpdateState>(IPC_REQUESTS.UPDATES_GET_STATE),
    install: () => request<void>(IPC_REQUESTS.UPDATES_INSTALL),
    installNow: () => request<void>(IPC_REQUESTS.UPDATES_INSTALL_NOW)
  },
  onSessionStatus: (handler) => on<SessionStatusEvent>(IPC_EVENTS.SESSION_STATUS, handler),
  onSessionActivity: (handler) =>
    on<{ sessionId: string; activity: SessionActivity | null }>(IPC_EVENTS.SESSION_ACTIVITY, handler),
  onSessionListChanged: (handler) => on<void>(IPC_EVENTS.SESSION_LIST_CHANGED, handler),
  onSessionDeleted: (handler) => on<{ sessionId: string }>(IPC_EVENTS.SESSION_DELETED, handler),
  onSessionDeleteFailed: (handler) =>
    on<{ sessionId: string; error: { code: IpcErrorCode; message: string } }>(IPC_EVENTS.SESSION_DELETE_FAILED, handler),
  onTranscriptPatch: (handler) => on<{ sessionId: string; ops: TranscriptOp[] }>(IPC_EVENTS.TRANSCRIPT_PATCH, handler),
  onQueueUpdate: (handler) =>
    on<{ sessionId: string; followUp: string[]; steering: string[] }>(IPC_EVENTS.QUEUE_UPDATE, handler),
  onRequestPending: (handler) =>
    on<{ sessionId: string; request: PendingRequest }>(IPC_EVENTS.REQUEST_PENDING, handler),
  onRequestResolved: (handler) => on<{ sessionId: string; requestId: string }>(IPC_EVENTS.REQUEST_RESOLVED, handler),
  onCommandsUpdate: (handler) =>
    on<{ sessionId: string; commands: SlashCommand[] }>(IPC_EVENTS.COMMANDS_UPDATE, handler),
  onSettingsChanged: (handler) => on<Settings>(IPC_EVENTS.SETTINGS_CHANGED, handler),
  onAlarmFired: (handler) => on<Alarm>(IPC_EVENTS.ALARM_FIRED, handler),
  onUiOpenSession: (handler) => on<{ sessionId: string }>(IPC_EVENTS.UI_OPEN_SESSION, handler),
  onMemoryWarning: (handler) => on<LowMemoryWarning>(IPC_EVENTS.MEMORY_WARNING, handler),
  onTokenGuardLaunchWarning: (handler) =>
    on<TokenGuardLaunchWarning>(IPC_EVENTS.TOKEN_GUARD_LAUNCH_WARNING, handler),
  onTokenGuardCalls: (handler) => on<TokenGuardCalls>(IPC_EVENTS.TOKEN_GUARD_CALLS, handler),
  onAgentToolsCall: (handler) => on<AgentToolCall>(IPC_EVENTS.AGENT_TOOLS_CALL, handler),
  onAdvisorRosterDetected: (handler) => on<AdvisorRosterDetected>(IPC_EVENTS.ADVISOR_ROSTER_DETECTED, handler),
  onReadoutUpdate: (handler) => on<{ sessionId: string; readout: SessionReadout }>(IPC_EVENTS.READOUT_UPDATE, handler),
  onSubagentsUpdate: (handler) =>
    on<{ sessionId: string; subagents: SubagentSummary[] }>(IPC_EVENTS.SUBAGENTS_UPDATE, handler),
  onAdvisorUpdate: (handler) => on<{ sessionId: string; advisorOn: boolean }>(IPC_EVENTS.ADVISOR_UPDATE, handler),
  onPrewalkUpdate: (handler) => on<{ sessionId: string; state: 'armed' | 'off' | 'unknown' }>(IPC_EVENTS.PREWALK_UPDATE, handler),
  onSessionHealth: (handler) => on<{ sessionId: string; rpcSlowMs: number | null; agentMemoryBytes: number | null }>(IPC_EVENTS.SESSION_HEALTH, handler),
  onSubagentPatch: (handler) =>
    on<{ sessionId: string; subagentId: string; ops: TranscriptOp[] }>(IPC_EVENTS.SUBAGENT_PATCH, handler),
  onSideChatPatch: (handler) =>
    on<{ sessionId: string; delta?: string; recordId?: string; record?: SideChatRecord; notice?: string }>(IPC_EVENTS.SIDE_CHAT_PATCH, handler),
  onSideChatInterrupted: (handler) => on<{ sessionId: string }>(IPC_EVENTS.SIDE_CHAT_INTERRUPTED, handler),
  onSideChatConversationChanged: (handler) => on<{ sessionId: string }>(IPC_EVENTS.SIDE_CHAT_CONVERSATION_CHANGED, handler),
  onFileExplorerPatch: (handler) =>
    on<{ sessionId: string; relativePath: string; entries: FileTreeNode[]; truncated: number }>(IPC_EVENTS.FILE_EXPLORER_PATCH, handler),
  onFileExplorerReset: (handler) => on<{ sessionId: string }>(IPC_EVENTS.FILE_EXPLORER_RESET, handler),
  onGitChangesRefresh: (handler) => on<{ sessionId: string }>(IPC_EVENTS.GIT_CHANGES_REFRESH, handler),
  onAccountsGithubChanged: (handler) => on<GitHubAccount[]>(IPC_EVENTS.ACCOUNTS_GITHUB_CHANGED, handler),
  onGithubChanged: (handler) => on<GithubChangedPayload>(IPC_EVENTS.GITHUB_CHANGED, handler),
  onAccountsGithubAddProgress: (handler) => on<GitHubAddFlowProgress>(IPC_EVENTS.ACCOUNTS_GITHUB_ADD_PROGRESS, handler),
  onReadinessInstallProgress: (handler) =>
    on<DependencyInstallProgress>(IPC_EVENTS.READINESS_INSTALL_PROGRESS, handler),
  onReadinessChanged: (handler) => on<Readiness>(IPC_EVENTS.READINESS_CHANGED, handler),
  onUpdatesStateChanged: (handler) => on<UpdateState>(IPC_EVENTS.UPDATES_STATE_CHANGED, handler)
}

// Set by `lib.rs`'s `setup` hook via a `WebviewWindowBuilder` initialization script (FR-010),
// before any other renderer script runs -- `themeBootstrap` above reads it directly (no inline
// cast) now that its shape is declared here.
declare global {
  interface Window {
    __REFRACT_THEME_BOOTSTRAP__?: { theme: ThemeId; typography?: Typography; customTheme?: CustomTheme | null; customThemeNotice?: 'reset' | 'missing' | null }
  }
}

export { refract }
