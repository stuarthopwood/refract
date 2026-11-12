// Renderer-to-main typed IPC contract; the only file allowed to cross that boundary (constitution V).
export type AgentToolName = 'refract_list_panels' | 'refract_open_panel' | 'refract_invoke_panel_action';
export interface AgentToolCall { sessionId: string; callId: string; tool: AgentToolName; args: Record<string, unknown> }
export type AgentToolReply = { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };

import type { GithubChangedPayload } from './ipc-github-changed';
import type { GitHubAccount, OmpProviderState, GitHubAddFlowProgress } from './accounts';
import type { LowMemoryWarning } from './lowMemoryWarning';
import type { TokenGuardCalls, TokenGuardHandoffResult, TokenGuardLaunchWarning, TokenGuardSnapshot } from './tokenGuard';
import type {
  Alarm,
  ApprovalMode,
  CatalogKind,
  ConversationInfo,
  DiffStat,
  FilePreview,
  FileTreeNode,
  GitStatusMap,
  ModelCatalogEntry,
  ModelRoleId,
  PendingRequest,
  ReadoutKind,
  ProjectColor,
  Repository,
  RepositoryRemote,
  Session,
  SessionListCollapse, SessionReadout,
  SessionStartProgress,
  SessionStatus,
  Settings,
  SplitLayout,
  SubagentSummary,
  TranscriptDisplaySettings,
  TranscriptItem,
} from './model';
import type { ImageContent, QueueKind, SideChatRecord, SlashCommandDescriptor } from './frames'; import type { ModelApi, RoleChangeSummary } from './ipc-model';
import type { WorkingMode, WorkingModeApi } from './workingMode';
import type { AdvisorRosterApi, AdvisorRosterDetected } from './ipc-advisor-roster';
import type { AttachmentsApi } from './ipc-attachments'; import type { ClipboardApi } from './ipc-clipboard'; import type { SpellcheckApi } from './ipc-spellcheck'; import type { DebugApi } from './ipc-debug'; import type { LeftoverSummary } from './ipc-sessions'; import type { ChatPauseApi } from './ipc-pause';
import type { GitChangesApi } from './ipc-git-changes'; import type { HomeApi } from './ipc-home'; import type { IssuesApi, SessionWithKickoff } from './ipc-issues'; import type { ItemRefsApi } from './ipc-item-refs'; import type { PullRequestsAcrossApi } from './ipc-pull-requests'; import type { FileExplorerApi } from './ipc-file-explorer'; import type { ThemeId } from './themes';
import type { GithubStackApi } from './ipc-github-stack';
import type { ChangedFile, FilterTab, MergeMethod, PullRequestDetail, PullRequestStateFilter, PullRequestSummary, ReviewVerdict } from './github';
import type { ChatWidth } from './chatWidth'; import type { HolidayTouches } from './holidayTouches'; import type { StatusStyle } from './statusStyle'; import type { ChatRowDensity } from './chatRowDensity';
import type { ActivityText, SessionActivity } from './activity'; import type { UpdatesApi } from './updates'; import type { ImagesApi } from './ipc-images'; import type { CustomTheme, ThemesApi } from './ipc-themes'; import type { RepositoriesCloneApi, SettingsCloneApi } from './ipc-repositories-clone';

/** The four top-level items of the in-app menu bar. */
export const APP_MENU_IDS = ['file', 'edit', 'view', 'window'] as const;
export type AppMenuId = (typeof APP_MENU_IDS)[number];

/** What a zoom shortcut asks the shell to do to the window's page zoom. */
export type ZoomAction = 'in' | 'out' | 'reset';


export type IpcErrorCode =
  | 'not-a-repo'
  | 'no-commits'
  | 'duplicate'
  | 'has-sessions'
  | 'git-failed'
  | 'worktree-failed'
  | 'base-missing'
  | 'path-too-long'
  | 'not-idle'
  | 'reattach-failed'
  | 'unknown-command'
  | 'unsupported-arguments'
  | 'branch-missing'
  | 'not-found'
  | 'invalid-argument'
  | 'prompt-failed'
  | 'agent-not-running'
  | 'start-failed'
  | 'worktree-missing'
  | 'file-missing'
  | 'outside-worktree'
  | 'clipboard-failed'
  | 'spellcheck-failed'
  | 'unsupported-image-type'
  | 'image-too-large'
  | 'invalid-theme'
  | 'gh-not-found'
  | 'gh-failed'
  | 'timeout'
  | 'account-not-found'
  | 'omp-probe-failed'
  | 'unsupported'
  | 'no-github-remote'
  | 'gh-unavailable'
  | 'rate-limited'
  | 'github-failed'
  | 'stale'
  | 'not-mergeable'
  | 'checkout-failed'
  | 'disabled'
  | 'session-archived'
  | 'worktree-held' | 'worktree-busy' | 'destination-not-empty' | 'too-many-clones' | 'destination-in-use'
  | 'dependency-install-failed' | 'update-unavailable' | 'checksum-mismatch' | 'settings-write-failed'; // lane R11b (#794); #1265 settings.json write failed

export interface IpcError {
  code: IpcErrorCode;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: IpcError };


export interface Check {
  ok: boolean;
  found?: string;
  hint?: string;
  warning?: boolean;
}

export interface Readiness {
  git: Check;
  omp: Check;
  ompSignedIn: Check;
}
/** `sessions.list()` row. */
export interface SessionSummary extends Session {
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  terminatedUnexpectedly?: boolean;
  startProgress?: SessionStartProgress;
  unread: boolean;
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null;
  workingMode?: WorkingMode;
  workingModePending?: WorkingMode | null;
  pinned?: boolean;
  pendingSelection?: {
    role: string | null;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string | null;
  } | null;
  currentRole?: string | null;
  activity?: SessionActivity | null;
}

/** `sessions.diffStat(id)` result. */
export type { DiffStat } from './model';

/** Mirror of the data-model.md entity of the same name. */
export type { FileTreeNode, FilePreview, GitStatusMap, GitChangesSnapshot } from './model';

/** The renderer-facing copy of main's in-memory SessionRuntime (data-model.md). */
export interface SessionRuntimeView {
  sessionId: string;
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  stopDetail?: string;
  terminatedUnexpectedly?: boolean;
  pendingToolNames?: string[];
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null;
  workingMode?: WorkingMode;
  workingModePending?: WorkingMode | null;
  unread: boolean;
  transcript: TranscriptItem[];
  queue: { followUp: string[]; steering: string[] };
  pending: PendingRequest[];
}

/** One `repositories.branches` entry for the Base branch picker. */
export interface BranchEntry {
  name: string;
  kind: 'default' | 'branch' | 'session';
  sessionName?: string;
  archived?: boolean;
}

/** Returned by `sessions.open`, `sessions.recover`, `conversations.startNew`, `conversations.open`. */
export interface SessionSnapshot {
  runtime: SessionRuntimeView;
  conversations: ConversationInfo[];
  readout: SessionReadout; // spec 004: initial chip-row bundle; subsequent changes via readout:update
  subagents: SubagentSummary[];
  advisorOn: boolean; // issue #937: initial Advisor-chip on/off state; subsequent changes via advisor:update
}

export type TranscriptOp = { op: 'upsert'; item: TranscriptItem } | { op: 'reset'; items: TranscriptItem[] };

export type SlashCommand = SlashCommandDescriptor;

export type ChatAnswer = { approve: boolean; option?: string } | { value: string } | { confirmed: boolean } | { cancelled: true } | { answers: { id: string; selectedOptions: string[]; customInput?: string }[] }; // #572: `answers` answers a `kind:'ask'` PendingRequest, one entry per question in request order, each `id` copied exactly (`omp://rpc.md`).

export type { LowMemoryWarning } from './lowMemoryWarning';
export type { TokenGuardCalls, TokenGuardHandoffResult, TokenGuardLaunchWarning, TokenGuardSnapshot } from './tokenGuard';

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  stopDetail?: string;
  terminatedUnexpectedly?: boolean;
  startProgress: SessionStartProgress | undefined;
  unread: boolean;
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null;
  workingMode?: WorkingMode;
  workingModePending?: WorkingMode | null;
}


/** `pullRequests.list` input. */
export interface PullRequestListResult {
  items: PullRequestSummary[];
  fetchedAt: string;
}

/** `pullRequests.submitReview` input. */
export interface SubmitReviewInput {
  verdict: Exclude<ReviewVerdict, 'dismissed'>; // dismissed: real post-submit verdict, never submittable (#568 decision 10)
  body?: string;
  expectedHeadSha: string;
}

/** `pullRequests.merge` input. */
export interface MergeInput {
  method: MergeMethod;
  expectedHeadSha: string;
}

/** Re-exported so existing imports from `../../shared/ipc` keep working (#891). */
export type { LeftoverSummary } from './ipc-sessions';


export const IPC_REQUESTS = {
  READINESS_CHECK: 'readiness.check',
  READINESS_CHECK_STEP: 'readiness.checkStep',
  REPOSITORIES_LIST: 'repositories.list',
  REPOSITORIES_ADD: 'repositories.add',
  REPOSITORIES_REMOVE: 'repositories.remove',
  REPOSITORIES_RENAME: 'repositories.rename',
  REPOSITORIES_SET_COLOR: 'repositories.setColor',
  REPOSITORIES_BRANCHES: 'repositories.branches',
  REPOSITORIES_REMOTES: 'repositories.remotes',
  REPOSITORIES_PICK_FOLDER: 'repositories.pickFolder',
  REPOSITORIES_USER_NAME: 'repositories.userName',
  REPOSITORIES_LIST_GITHUB: 'repositories.listGitHub',
  REPOSITORIES_CLONE: 'repositories.clone',
  REPOSITORIES_CLONE_CANCEL: 'repositories.cloneCancel',
  SESSIONS_LIST: 'sessions.list',
  SESSIONS_CREATE: 'sessions.create',
  SESSIONS_RENAME: 'sessions.rename',
  SESSIONS_OPEN: 'sessions.open',
  SESSIONS_ARCHIVE: 'sessions.archive',
  SESSIONS_RESTORE: 'sessions.restore',
  SESSIONS_SET_HIDDEN: 'sessions.setHidden',
  SESSIONS_DELETE_CHECK: 'sessions.deleteCheck',
  SESSIONS_DELETE_LEFTOVER_SUMMARY: 'sessions.deleteLeftoverSummary',
  SESSIONS_DELETE: 'sessions.delete',
  SESSIONS_DELETING: 'sessions.deleting',
  SESSIONS_RECREATE_WORKTREE: 'sessions.recreateWorktree',
  SESSIONS_RECOVER: 'sessions.recover',
  SESSIONS_RESUME: 'sessions.resume',
  SESSIONS_STOP_AGENT: 'sessions.stopAgent',
  SESSIONS_KEEP_WAITING_FOR_START: 'sessions.keepWaitingForStart',
  SESSIONS_CANCEL_START: 'sessions.cancelStart',
  SESSIONS_SET_VISIBLE: 'sessions.setVisible',
  SESSIONS_DIFF_STAT: 'sessions.diffStat',
  SESSIONS_REVEAL_WORKTREE: 'sessions.revealWorktree',
  SESSIONS_REVEAL_FILE: 'sessions.revealFile',
  ATTACHMENTS_READ_IMAGE_FILE: 'attachments.readImageFile',
  ATTACHMENTS_READ_FILE: 'attachments.readFile',
  ATTACHMENTS_PICK_FILES: 'attachments.pickFiles',
  ATTACHMENTS_RECORD_DROPPED_PATHS: 'attachments.recordDroppedPaths',
  IMAGES_GET: 'images.get',
  CLIPBOARD_WRITE_TEXT: 'clipboard.writeText',
  CLIPBOARD_READ_TEXT: 'clipboard.readText',
  CLIPBOARD_WRITE_IMAGE: 'clipboard.writeImage',
  CLIPBOARD_SAVE_IMAGE: 'clipboard.saveImage',
  SPELLCHECK_SUGGEST: 'spellcheck.suggest',
  SPELLCHECK_ADD: 'spellcheck.add',
  CONVERSATIONS_LIST: 'conversations.list',
  CONVERSATIONS_START_NEW: 'conversations.startNew',
  CONVERSATIONS_OPEN: 'conversations.open',
  CHAT_SEND: 'chat.send',
  CHAT_STOP: 'chat.stop',
  CHAT_REMOVE_QUEUED: 'chat.removeQueued',
  CHAT_SEND_NOW: 'chat.sendNow',
  CHAT_PAUSE: 'chat.pause',
  CHAT_RESUME: 'chat.resume',
  CHAT_PAUSE_ALL: 'chat.pauseAll',
  CHAT_RESUME_ALL: 'chat.resumeAll',
  CHAT_ANSWER: 'chat.answer',
  CHAT_COMMANDS: 'chat.commands',
  CHAT_PREDICT_WORD: 'chat.predictWord',
  CHAT_PREDICT_WORD_FEEDBACK: 'chat.predictWordFeedback',
  CHAT_SET_VISIBLE_SUBAGENT: 'chat.setVisibleSubagent',
  CHAT_SUBAGENT_SNAPSHOT: 'chat.subagentSnapshot',
  SIDE_CHAT_ASK: 'sideChat.ask',
  SIDE_CHAT_CANCEL: 'sideChat.cancel',
  SIDE_CHAT_GET_HISTORY: 'sideChat.getHistory',
  FILE_EXPLORER_LIST_DIRECTORY: 'fileExplorer.listDirectory',
  FILE_EXPLORER_READ_PREVIEW: 'fileExplorer.readPreview',
  FILE_EXPLORER_GET_STATUS: 'fileExplorer.getStatus',
  FILE_EXPLORER_OPEN_IN_VSCODE: 'fileExplorer.openInVSCode',
  FILE_EXPLORER_REVEAL: 'fileExplorer.reveal',
  FILE_EXPLORER_COPY_PATH: 'fileExplorer.copyPath',
  FILE_EXPLORER_STOP_WATCHING: 'fileExplorer.stopWatching',
  FILE_EXPLORER_ENSURE_WATCHING: 'fileExplorer.ensureWatching',
  GIT_CHANGES_LIST: 'gitChanges.list',
  GIT_CHANGES_STAGE: 'gitChanges.stage',
  GIT_CHANGES_UNSTAGE: 'gitChanges.unstage',
  GIT_CHANGES_STAGE_ALL: 'gitChanges.stageAll',
  GIT_CHANGES_UNSTAGE_ALL: 'gitChanges.unstageAll',
  GIT_CHANGES_COMMIT: 'gitChanges.commit',
  GIT_CHANGES_DIFF: 'gitChanges.diff',
  GIT_CHANGES_ENSURE_WATCHING: 'gitChanges.ensureWatching',
  GIT_CHANGES_STOP_WATCHING: 'gitChanges.stopWatching',
  SETTINGS_GET: 'settings.get',
  SETTINGS_SET_APPROVAL_MODE: 'settings.setApprovalMode',
  SETTINGS_SET_READOUT_VISIBILITY: 'settings.setReadoutVisibility',
  SETTINGS_SET_SPLIT: 'settings.setSplit',
  SETTINGS_SET_WATERMARK_ENABLED: 'settings.setWatermarkEnabled',
  SETTINGS_SET_TRANSCRIPT_DISPLAY: 'settings.setTranscriptDisplay',
  SETTINGS_SET_SHOW_SAMPLE_DATA: 'settings.setShowSampleData',
  SETTINGS_SET_DETECT_IMAGE_PATHS_ON_PASTE: 'settings.setDetectImagePathsOnPaste',
  SETTINGS_SET_SHOW_CONTEXT_USAGE_BAR: 'settings.setShowContextUsageBar',
  SETTINGS_SET_SHOW_AGENT_STOPPED_BAR: 'settings.setShowAgentStoppedBar',
  SETTINGS_SET_SHOW_AI_CREDITS: 'settings.setShowAiCredits',
  SETTINGS_SET_ANIMATED_STATUS_TEXT: 'settings.setAnimatedStatusText',
  SETTINGS_SET_CODE_LIGATURES: 'settings.setCodeLigatures',
  SETTINGS_SET_SHOW_SCROLLBAR_MAP: 'settings.setShowScrollbarMap',
  SETTINGS_SET_TYPOGRAPHY: 'settings.setTypography',
  SETTINGS_SET_SHOW_FINISHED_TURN_TIMES: 'settings.setShowFinishedTurnTimes',
  SETTINGS_SET_STACKED_PULL_REQUESTS: 'settings.setStackedPullRequests',
  SETTINGS_SET_SESSION_NOTIFICATION_SOUNDS: 'settings.setSessionNotificationSounds',
  SETTINGS_SET_ALARM_SOUNDS: 'settings.setAlarmSounds',
  SETTINGS_UPSERT_ALARM: 'settings.upsertAlarm',
  SETTINGS_DELETE_ALARM: 'settings.deleteAlarm',
  SETTINGS_SET_WORD_PREDICTION_ENABLED: 'settings.setWordPredictionEnabled',
  SETTINGS_SET_SESSION_LIST_COLLAPSE: 'settings.setSessionListCollapse',
  SETTINGS_SET_PULL_REQUESTS_LIST_WIDTH: 'settings.setPullRequestsListWidth',
  SETTINGS_SET_RIGHT_PANE: 'settings.setRightPane',
  SETTINGS_SET_CHAT_WIDTH: 'settings.setChatWidth',
  SETTINGS_SET_HOLIDAY_TOUCHES: 'settings.setHolidayTouches',
  SETTINGS_SET_ACTIVITY_TEXT: 'settings.setActivityText',
  SETTINGS_SET_STATUS_STYLE: 'settings.setStatusStyle',
  SETTINGS_SET_CHAT_ROW_DENSITY: 'settings.setChatRowDensity',
  SETTINGS_SET_DEFAULT_CLONE_FOLDER: 'settings.setDefaultCloneFolder',
  DEBUG_GET_OVERRIDES: 'debug.getOverrides',
  MODEL_ROLES_LIST: 'modelRoles.list',
  MODEL_ROLES_SET: 'modelRoles.set',
  MODEL_ROLES_LIST_CATALOG: 'modelRoles.listCatalog',
  MODEL_SET_MODEL: 'model.setModel',
  MODEL_CYCLE_MODEL: 'model.cycleModel',
  MODEL_APPLY_ROLE: 'model.applyRole',
  MODEL_LIST_ROLES: 'model.listRoles',
  MODEL_SET_THINKING_LEVEL: 'model.setThinkingLevel',
  WORKING_MODE_SET: 'workingMode.set',
  WINDOW_POPUP_MENU: 'window.popupMenu',
  WINDOW_ZOOM: 'window.zoom',
  PULL_REQUESTS_LIST: 'pullRequests.list',
  PULL_REQUESTS_LIST_ACROSS: 'pullRequests.listAcross',
  PULL_REQUESTS_DETAIL: 'pullRequests.detail',
  PULL_REQUESTS_COMMENT: 'pullRequests.comment',
  PULL_REQUESTS_REPLY_TO_THREAD: 'pullRequests.replyToThread',
  PULL_REQUESTS_RESOLVE_THREAD: 'pullRequests.resolveThread',
  PULL_REQUESTS_UNRESOLVE_THREAD: 'pullRequests.unresolveThread',
  PULL_REQUESTS_SUBMIT_REVIEW: 'pullRequests.submitReview',
  PULL_REQUESTS_MERGE: 'pullRequests.merge',
  PULL_REQUESTS_CLOSE: 'pullRequests.close',
  PULL_REQUESTS_FETCH_IMAGE: 'pullRequests.fetchImage',
  PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST: 'pullRequests.newSessionFromPullRequest',
  GITHUB_STACK_STATE: 'githubStack.state',
  GITHUB_STACK_INSTALL: 'githubStack.install',
  ISSUES_LABELS: 'issues.labels',
  ISSUES_SEARCH: 'issues.search',
  ISSUES_CREATE: 'issues.create',
  ISSUES_LIST: 'issues.list',
  ISSUES_VIEW: 'issues.view',
  ISSUES_NEW_SESSION: 'issues.newSession',
  ITEM_REFS_LOOKUP: 'itemRefs.lookup',
  ITEM_REFS_SEARCH: 'itemRefs.search',
  HOME_LAST_MESSAGES: 'home.lastMessages',
  HOME_CLOSED_BRANCHES: 'home.closedBranches',
  THEME_SET: 'theme.set',
  THEME_SET_CUSTOM: 'theme.setCustom',
  THEMES_LIST: 'themes.list',
  THEMES_IMPORT: 'themes.import',
  THEMES_EXPORT: 'themes.export',
  THEMES_REMOVE: 'themes.remove',
  THEMES_OPEN_FOLDER: 'themes.openFolder',
  TOKEN_GUARD_GET: 'tokenGuard.get',
  TOKEN_GUARD_SET: 'tokenGuard.set',
  TOKEN_GUARD_RESET: 'tokenGuard.reset',
  TOKEN_GUARD_RESET_ALL: 'tokenGuard.resetAll',
  TOKEN_GUARD_DISMISS_THRESHOLDS_RESET: 'tokenGuard.dismissThresholdsReset',
  TOKEN_GUARD_HANDOFF: 'tokenGuard.handoff',
  AGENT_TOOLS_RESULT: 'agentTools.result',
  AGENT_TOOLS_STARTED: 'agentTools.started',
  ADVISOR_ROSTER_DETECT: 'advisorRoster.detect',
  ADVISOR_ROSTER_OPEN: 'advisorRoster.open',
  COPILOT_PLAN_USAGE: 'copilot.planUsage',
  ACCOUNTS_GITHUB_LIST: 'accounts.github.list',
  ACCOUNTS_GITHUB_ADD_START: 'accounts.github.addStart',
  ACCOUNTS_GITHUB_ADD_CANCEL: 'accounts.github.addCancel',
  ACCOUNTS_GITHUB_SWITCH: 'accounts.github.switch',
  ACCOUNTS_GITHUB_SIGN_OUT: 'accounts.github.signOut',
  ACCOUNTS_OMP_LIST: 'accounts.omp.list',
  ACCOUNTS_OMP_SIGN_IN: 'accounts.omp.signIn',
  ACCOUNTS_OMP_SIGN_OUT: 'accounts.omp.signOut',
  ACCOUNTS_OMP_ANSWER: 'accounts.omp.answer',
  APP_OPEN_RELEASE_NOTES: 'app.openReleaseNotes',
  READINESS_INSTALL_DEPENDENCY: 'readiness.installDependency',
  UPDATES_CHECK: 'updates.check',
  UPDATES_GET_STATE: 'updates.getState',
  UPDATES_INSTALL: 'updates.install',
  UPDATES_INSTALL_NOW: 'updates.installNow',
  APP_GET_VERSION: 'app.getVersion',
} as const;

export const IPC_EVENTS = {
  SESSION_STATUS: 'session:status',
  SESSION_ACTIVITY: 'session:activity',
  SESSION_LIST_CHANGED: 'session:list-changed',
  SESSION_DELETED: 'sessions:deleted',
  SESSION_DELETE_FAILED: 'sessions:delete-failed',
  TRANSCRIPT_PATCH: 'transcript:patch',
  QUEUE_UPDATE: 'queue:update',
  REQUEST_PENDING: 'request:pending',
  REQUEST_RESOLVED: 'request:resolved',
  COMMANDS_UPDATE: 'commands:update',
  SETTINGS_CHANGED: 'settings:changed',
  ALARM_FIRED: 'alarm:fired',
  UI_OPEN_SESSION: 'ui:open-session',
  MEMORY_WARNING: 'memory:warning',
  TOKEN_GUARD_LAUNCH_WARNING: 'token-guard:launch-warning',
  TOKEN_GUARD_CALLS: 'token-guard:calls',
  AGENT_TOOLS_CALL: 'agent-tools:call',
  ADVISOR_ROSTER_DETECTED: 'advisor-roster:detected',
  READOUT_UPDATE: 'readout:update',
  SUBAGENTS_UPDATE: 'subagents:update',
  ADVISOR_UPDATE: 'advisor:update',
  PREWALK_UPDATE: 'prewalk:update',
  SESSION_HEALTH: 'session:health',
  SUBAGENT_PATCH: 'subagent:patch',
  SIDE_CHAT_PATCH: 'side-chat:patch',
  SIDE_CHAT_INTERRUPTED: 'side-chat:interrupted',
  SIDE_CHAT_CONVERSATION_CHANGED: 'side-chat:conversation-changed',
  FILE_EXPLORER_PATCH: 'file-explorer:patch',
  FILE_EXPLORER_RESET: 'file-explorer:reset',
  GIT_CHANGES_REFRESH: 'git-changes:refresh',
  ACCOUNTS_GITHUB_CHANGED: 'accounts:github-changed',
  GITHUB_CHANGED: 'github:changed',
  ACCOUNTS_GITHUB_ADD_PROGRESS: 'accounts:github-add-progress',
  READINESS_INSTALL_PROGRESS: 'readiness:install-progress',
  READINESS_CHANGED: 'readiness:changed',
  UPDATES_STATE_CHANGED: 'updates:state-changed',
  REPOSITORIES_CLONE_PROGRESS: 'repositories:clone-progress',
} as const;

/** The bootstrap payload (contracts/ipc.md). */
export const THEME_BOOTSTRAP_CHANNEL = 'theme:bootstrap';


/** An unsubscribe function returned by every `on*` event subscription. */
export type Unsubscribe = () => void;

export interface RefractApi extends UpdatesApi, ImagesApi {
  repositories: RepositoriesCloneApi & {
    list(): Promise<Result<Repository[]>>;
    add(path: string): Promise<Result<Repository>>;
    remove(id: string): Promise<Result<void>>;
    rename(id: string, name: string): Promise<Result<Repository>>;
    setColor(id: string, color: ProjectColor | null): Promise<Result<Repository>>; // Issue #887: null clears; the result has no `remote`.
    remotes(): Promise<Result<Record<string, RepositoryRemote>>>;
    branches(id: string): Promise<Result<BranchEntry[]>>;
    pickFolder(): Promise<Result<string | null>>;
    userName(id: string): Promise<Result<string>>;
  };

  sessions: {
    list(): Promise<Result<SessionSummary[]>>;
    create(input: { repositoryId: string; baseBranch: string }): Promise<Result<Session>>;
    rename(id: string, name: string): Promise<Result<void>>;
    open(id: string, userAction?: boolean): Promise<Result<SessionSnapshot>>;
    archive(id: string): Promise<Result<void>>;
    restore(id: string): Promise<Result<void>>;
    setHidden(id: string, hidden: boolean): Promise<Result<void>>; // #748: view flag only, never stops the agent
    deleteCheck(id: string): Promise<Result<{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }>>;
    deleteLeftoverSummary(id: string): Promise<Result<LeftoverSummary>>;
    /** Returns once the checks pass; removal continues in the background (`onSessionDeleted` / `onSessionDeleteFailed`). */
    delete(id: string, options: { confirmed: true }): Promise<Result<void>>;
    /** Ids whose removal is still in flight; restores Deleting… rows after a reload. */
    deleting(): Promise<Result<string[]>>;
    recreateWorktree(id: string): Promise<Result<void>>;
    recover(id: string): Promise<Result<SessionSnapshot>>;
    resume(id: string): Promise<Result<SessionSnapshot>>;
    stopAgent(sessionId: string): Promise<Result<void>>;
    keepWaitingForStart(sessionId: string): Promise<Result<void>>;
    cancelStart(sessionId: string): Promise<Result<void>>;
    setVisible(sessionIds: string[]): Promise<Result<void>>;
    diffStat(id: string): Promise<Result<DiffStat | null>>;
    revealWorktree(id: string): Promise<Result<void>>;
    revealFile(sessionId: string, path: string): Promise<Result<void>>;
  };

  attachments: AttachmentsApi;

  clipboard: ClipboardApi;
  advisorRoster: AdvisorRosterApi;
  spellcheck: SpellcheckApi;

  conversations: {
    list(sessionId: string): Promise<Result<ConversationInfo[]>>;
    startNew(sessionId: string): Promise<Result<SessionSnapshot>>;
    open(sessionId: string, file: string): Promise<Result<SessionSnapshot>>;
  };

  chat: {
    send(sessionId: string, text: string, images?: ImageContent[]): Promise<Result<{ queued: boolean }>>;
    stop(sessionId: string): Promise<Result<import('./stop-result').StopResult>>;
    removeQueued(sessionId: string, text: string, queue: QueueKind): Promise<Result<{ removed: boolean }>>;
    sendNow(sessionId: string, text: string): Promise<Result<{ promoted: boolean }>>;
    answer(sessionId: string, requestId: string, answer: ChatAnswer): Promise<Result<void>>;
    commands(sessionId: string): Promise<Result<SlashCommand[]>>;
    predictWord(sessionId: string, text: string, cursor: number): Promise<Result<string | null>>;
    predictWordFeedback(
      sessionId: string,
      text: string,
      cursor: number,
      suggestion: string,
      accepted: boolean
    ): Promise<Result<void>>;
    setVisibleSubagent(sessionId: string, subagentId: string | null): Promise<Result<void>>;
    subagentSnapshot(sessionId: string, subagentId: string): Promise<Result<TranscriptItem[]>>;
  } & ChatPauseApi;

  sideChat: {
    ask(sessionId: string, question: string, recordId?: string): Promise<Result<{ record: SideChatRecord }>>;
    cancel(sessionId: string): Promise<Result<void>>;
    getHistory(sessionId: string): Promise<Result<SideChatRecord[]>>;
  };

  fileExplorer: FileExplorerApi;

  gitChanges: GitChangesApi;
  agentTools: {
    result(sessionId: string, callId: string, reply: AgentToolReply): Promise<Result<void>>;
    /** Tells Rust a mutating action is about to change files; only `accepted: true` allows it to proceed. */
    started(sessionId: string, callId: string): Promise<Result<{ accepted: boolean }>>;
  };
  issues: IssuesApi; itemRefs: ItemRefsApi; home: HomeApi;

  settings: SettingsCloneApi & {
    get(): Promise<Result<Settings>>;
    setApprovalMode(mode: ApprovalMode): Promise<Result<Settings>>;
    setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<Result<Settings>>;
    setSplit(layout: SplitLayout | null): Promise<Result<Settings>>;
    setWatermarkEnabled(enabled: boolean): Promise<Result<Settings>>;
    setTranscriptDisplay(field: keyof TranscriptDisplaySettings, visible: boolean): Promise<Result<Settings>>;
    setShowSampleData(enabled: boolean): Promise<Result<Settings>>;
    setDetectImagePathsOnPaste(enabled: boolean): Promise<Result<Settings>>;
    setShowContextUsageBar(enabled: boolean): Promise<Result<Settings>>; // Issue #1082 (spec 004 FR-034).
    setShowAiCredits(enabled: boolean): Promise<Result<Settings>>; // #1238.
    setShowAgentStoppedBar(enabled: boolean): Promise<Result<Settings>>; // Issue #1205 (FR-107): only hides the "Agent stopped" bar; never changes history-only opening.
    setWordPredictionEnabled(enabled: boolean): Promise<Result<Settings>>; // Issue #772
    setChatWidth(width: ChatWidth): Promise<Result<Settings>>; // Issue #554 (FR-073): whole-row persist, same race-safety pattern as every other setter here. No separate preview channel -- the live preview (`chat-width-store.ts`) is renderer-local only.
    setHolidayTouches(value: HolidayTouches): Promise<Result<Settings>>; // Issue #1048: whole-row persist, same race-safety pattern as setChatWidth. Applies live, no separate preview channel.
    setAnimatedStatusText(enabled: boolean): Promise<Result<Settings>>; // Issue #1242 (FR-042): the shared status-text shimmer switch; applies live.
    setCodeLigatures(enabled: boolean): Promise<Result<Settings>>; setShowScrollbarMap(enabled: boolean): Promise<Result<Settings>>; // Issue #1246; #754 (spec 041) scrollbar map switch
    setStackedPullRequests(enabled: boolean): Promise<Result<Settings>>; // Issue #1867: default on; the Pull requests Merge button and Session notes read it.
    setTypography(value: NonNullable<Settings['typography']>): Promise<Result<Settings>>; // Spec 036: Rust clamps each scale to 0.8..1.5; pushes settings:changed.
    upsertAlarm(alarm: Alarm): Promise<Result<Settings>>; // Issue #1426: create or edit one composer-clock Alarm; `alarm-limit` when the list is full.
    deleteAlarm(id: string): Promise<Result<Settings>>;
    setShowFinishedTurnTimes(enabled: boolean): Promise<Result<Settings>>; // Issue #1250 (FR-119): the settled turn total switch; applies live.
    setSessionNotificationSounds(enabled: boolean): Promise<Result<Settings>>; setAlarmSounds(enabled: boolean): Promise<Result<Settings>>; // Issue #1666: OS notification sound switches, both default on.
    setStatusStyle(value: StatusStyle): Promise<Result<Settings>>; setChatRowDensity(value: ChatRowDensity): Promise<Result<Settings>>; setActivityText(value: ActivityText): Promise<Result<Settings>>; // #482 setStatusStyle (Appearance Status style, applies live). #526 (FR-111): same pattern as setHolidayTouches; applies live.
    setSessionListCollapse(value: SessionListCollapse): Promise<Result<Settings>>; // #735: whole-value write, same race-safety pattern as setSplit; session-list-store.ts never reads the reply or a later broadcast back into itself.
    setRightPane(value: Settings['rightPane']): Promise<Result<Settings>>; // Spec 024: sole writer is `right-pane-persistence.ts`; Rust clamps width and repairs the active tab. Pushes settings:changed.
    setPullRequestsListWidth(widthPx: number): Promise<Result<Settings>>; // #930: one width for every Project; clamped, never rejected, by SettingsStore itself. Pushes settings:changed, no new event.
  };

  debug: DebugApi;

  modelRoles: {
    list(): Promise<Result<Record<string, string>>>;
    set(role: ModelRoleId, value: string | null): Promise<Result<{ roles: Record<string, string>; overriddenBy?: string; propagation?: RoleChangeSummary }>>;
    listCatalog(kind: CatalogKind): Promise<Result<ModelCatalogEntry[]>>;
  };

  model: ModelApi;

  workingMode: WorkingModeApi;

  window: {
    popupMenu(menuId: AppMenuId, x: number, y: number): Promise<Result<void>>;
    zoom(action: ZoomAction): Promise<Result<void>>;
  };

  pullRequests: PullRequestsAcrossApi & {
    list(repositoryId: string, tab: FilterTab, state: PullRequestStateFilter, query?: string): Promise<Result<PullRequestListResult>>;
    detail(repositoryId: string, number: number): Promise<Result<PullRequestDetail>>;
    comment(repositoryId: string, number: number, body: string): Promise<Result<{ id: string }>>;
    replyToThread(repositoryId: string, number: number, threadId: string, body: string): Promise<Result<{ id: string }>>;
    resolveThread(repositoryId: string, number: number, threadId: string): Promise<Result<void>>;
    unresolveThread(repositoryId: string, number: number, threadId: string): Promise<Result<void>>;
    submitReview(repositoryId: string, number: number, input: SubmitReviewInput): Promise<Result<{ id: string }>>;
    merge(repositoryId: string, number: number, input: MergeInput): Promise<Result<void>>;
    close(repositoryId: string, number: number): Promise<Result<Record<string, never>>>;
    fetchImage(url: string): Promise<Result<{ dataUrl: string }>>;
    newSessionFromPullRequest(repositoryId: string, number: number): Promise<Result<SessionWithKickoff>>;
  };

  githubStack: GithubStackApi;

  theme: {
    set(themeId: ThemeId): Promise<Result<Settings>>;
  };
  themes: ThemesApi;

  tokenGuard: {
    get(repositoryId?: string): Promise<Result<TokenGuardSnapshot>>;
    set(key: string, value: unknown, repositoryId?: string): Promise<Result<TokenGuardSnapshot>>;
    reset(key: string, repositoryId?: string): Promise<Result<TokenGuardSnapshot>>;
    resetAll(repositoryId?: string): Promise<Result<TokenGuardSnapshot>>;
    /** Marks the one-time migration backup notice as shown. */
    dismissMigrationNotice(): Promise<Result<null>>;
    handoff(sessionId: string): Promise<Result<TokenGuardHandoffResult>>;
  };

  copilot: { planUsage(): Promise<Result<{ percentUsed: number } | null>> }; // #1238; null = unavailable.

  themeBootstrap(): { theme: ThemeId; typography?: Settings['typography']; customTheme?: CustomTheme | null; customThemeNotice?: 'reset' | 'missing' | null };

  accounts: {
    github: {
      list(): Promise<Result<GitHubAccount[]>>;
      addStart(): Promise<Result<{ flowId: string }>>;
      addCancel(flowId: string): Promise<Result<void>>;
      switch(host: string, login: string): Promise<Result<GitHubAccount[]>>;
      signOut(host: string, login: string): Promise<Result<GitHubAccount[]>>;
    };
    omp: {
      list(): Promise<Result<OmpProviderState[]>>;
      signIn(providerId: string): Promise<Result<{ requestId: string | null }>>;
      signOut(providerId: string): Promise<Result<{ requestId: string | null }>>;
      answer(requestId: string, answer: ChatAnswer): Promise<Result<void>>;
    };
  };

  app: {
    openReleaseNotes(): Promise<Result<void>>;
    getVersion(): Promise<Result<string>>; // lane R11b (#794): for the update badge
  };

  onSessionStatus(handler: (payload: SessionStatusEvent) => void): Unsubscribe;
  onSessionActivity(handler: (payload: { sessionId: string; activity: SessionActivity | null }) => void): Unsubscribe; // #526 (FR-109)
  onSessionListChanged(handler: () => void): Unsubscribe;
  onSessionDeleted(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onSessionDeleteFailed(
    handler: (payload: { sessionId: string; error: { code: IpcErrorCode; message: string } }) => void
  ): Unsubscribe;
  onTranscriptPatch(handler: (payload: { sessionId: string; ops: TranscriptOp[] }) => void): Unsubscribe;
  onQueueUpdate(handler: (payload: { sessionId: string; followUp: string[]; steering: string[] }) => void): Unsubscribe;
  onRequestPending(handler: (payload: { sessionId: string; request: PendingRequest }) => void): Unsubscribe;
  onRequestResolved(handler: (payload: { sessionId: string; requestId: string }) => void): Unsubscribe;
  onCommandsUpdate(handler: (payload: { sessionId: string; commands: SlashCommand[] }) => void): Unsubscribe;
  onSettingsChanged(handler: (payload: Settings) => void): Unsubscribe;
  onAlarmFired(handler: (payload: Alarm) => void): Unsubscribe;
  onUiOpenSession(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onMemoryWarning(handler: (payload: LowMemoryWarning) => void): Unsubscribe;
  onTokenGuardLaunchWarning(handler: (payload: TokenGuardLaunchWarning) => void): Unsubscribe;
  onTokenGuardCalls(handler: (payload: TokenGuardCalls) => void): Unsubscribe;
  onAgentToolsCall(handler: (payload: AgentToolCall) => void): Unsubscribe;
  onAdvisorRosterDetected(handler: (payload: AdvisorRosterDetected) => void): Unsubscribe;
  onReadoutUpdate(handler: (payload: { sessionId: string; readout: SessionReadout }) => void): Unsubscribe;
  onSubagentsUpdate(handler: (payload: { sessionId: string; subagents: SubagentSummary[] }) => void): Unsubscribe;
  onAdvisorUpdate(handler: (payload: { sessionId: string; advisorOn: boolean }) => void): Unsubscribe;
  /** `unknown` until OMP's own prewalk reply says otherwise (#695). */
  onPrewalkUpdate(handler: (payload: { sessionId: string; state: 'armed' | 'off' | 'unknown' }) => void): Unsubscribe;
  onSessionHealth(handler: (payload: { sessionId: string; rpcSlowMs: number | null; agentMemoryBytes: number | null }) => void): Unsubscribe;
  onSubagentPatch(handler: (payload: { sessionId: string; subagentId: string; ops: TranscriptOp[] }) => void): Unsubscribe;
  onSideChatPatch(handler: (payload: { sessionId: string; delta?: string; recordId?: string; record?: SideChatRecord; notice?: string }) => void): Unsubscribe;
  onSideChatInterrupted(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onSideChatConversationChanged(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onFileExplorerPatch(
    handler: (payload: { sessionId: string; relativePath: string; entries: FileTreeNode[]; truncated: number }) => void
  ): Unsubscribe;
  onFileExplorerReset(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onGitChangesRefresh(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onAccountsGithubChanged(handler: (payload: GitHubAccount[]) => void): Unsubscribe;
  onGithubChanged(handler: (payload: GithubChangedPayload) => void): Unsubscribe;
  onAccountsGithubAddProgress(handler: (payload: GitHubAddFlowProgress) => void): Unsubscribe;
}

declare global {
  interface Window {
    refract: RefractApi;
  }
}
