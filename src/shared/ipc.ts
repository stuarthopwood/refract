// Contract for the renderer-to-main typed IPC, per
// specs/001-core-session-workspace/contracts/ipc.md. Imported by main, preload, and renderer; this is the only file that may cross that boundary (constitution V).

import type { GitHubAccount, OmpProviderState, GitHubAddFlowProgress } from './accounts';
import type { LowMemoryWarning } from './lowMemoryWarning';
import type { TokenGuardCalls, TokenGuardHandoffResult, TokenGuardLaunchWarning, TokenGuardSnapshot } from './tokenGuard';
import type {
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
import type { AttachmentsApi } from './ipc-attachments'; import type { DebugApi } from './ipc-debug'; import type { LeftoverSummary } from './ipc-sessions'; import type { ChatPauseApi } from './ipc-pause';
import type { GitChangesApi } from './ipc-git-changes'; import type { IssuesApi } from './ipc-issues'; import type { FileExplorerApi } from './ipc-file-explorer'; import type { ThemeId } from './themes';
import type {
  ChangedFile, FilterTab, MergeMethod, PullRequestDetail,
  PullRequestStateFilter, PullRequestSummary, ReviewVerdict
} from './github';
import type { ChatWidth } from './chatWidth'; import type { HolidayTouches } from './holidayTouches'; import type { StatusStyle } from './statusStyle'; import type { ChatRowDensity } from './chatRowDensity';
import type { ActivityText, SessionActivity } from './activity'; import type { UpdatesApi } from './updates'; import type { ImagesApi } from './ipc-images'; import type { RepositoriesCloneApi, SettingsCloneApi } from './ipc-repositories-clone';

/** The four top-level items of the in-app menu bar (spec 001 T100, FR-057): `window.popupMenu`
 * asks the host to pop open the one real `Menu` built from this same set, so a dev-only item
 * (Reload, Force Reload, Toggle Developer Tools) is included or not by that one menu, never a
 * second renderer-side copy of the decision. The one shared list of ids: the menu tags each item
 * with a matching `id`, `AppMenuBar.tsx` derives its button list from it, and the host
 * validates incoming ids against it -- a single source instead of three copies. */
export const APP_MENU_IDS = ['file', 'edit', 'view', 'window'] as const;
export type AppMenuId = (typeof APP_MENU_IDS)[number];

// ---------------------------------------------------------------------------
// Result and errors
// ---------------------------------------------------------------------------

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
  | 'worktree-missing'
  | 'file-missing'
  | 'outside-worktree'
  | 'clipboard-failed'
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

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface Check {
  ok: boolean;
  found?: string;
  hint?: string;
  /** `ok: true` with `warning: true`: the check passed but found something worth surfacing to
   * the developer without blocking them (e.g. an omp version newer than any specifically
   * verified one). Never set alongside `ok: false` -- a hard failure always blocks instead. */
  warning?: boolean;
}

export interface Readiness {
  git: Check;
  omp: Check;
  ompSignedIn: Check;
}
/** `sessions.list()` row: a Session plus its live-runtime view. `lastModel`/`lastThinkingLevel`
 * (T062) come straight through from `Session`: the last known provider/model/thinking level,
 * absent until the first `get_state`. */
export interface SessionSummary extends Session {
  status: SessionStatus;
  /** T043: surfaces `worktree-missing`/`not-started` in the list row itself, so a missing
   * worktree shows a distinct badge without opening the Session. */
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  /** Issue #510 slice 2 (PLAN.md row A0): `true` only for a `stopped` Session whose Conversation
   * file's tail (`detectUnexpectedTermination`, terminationDetection.ts) shows the writing
   * process went away mid-turn, independent of `stopReason` -- this is what still flags a cold
   * app restart after a crash, which only ever carries `stopReason: 'not-started'`. Always
   * `false`/absent for a Session with no Conversation yet. */
  terminatedUnexpectedly?: boolean;
  /** Issue #512: live while this Session's start is in flight (row-level "Starting agent... N
   * s"); absent once it settles. */
  startProgress?: SessionStartProgress;
  unread: boolean;
  /** The mode the Session's live process actually launched with (settings' current mode for one
   * that has never run): the pill's "currently in effect" mode while `pendingMode` is set. */
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null;
  /** Lane RM (#740, #741): `true` once chosen directly (picker, `/switch`, `/model`, cycle) --
   * a later Settings role change skips it. Optional: Electron never ports this family. */
  pinned?: boolean;
  /** #766 part A: a role/model and/or reasoning change chosen while the Session was working or
   * stopped, held in Rust and applied at the next idle (before the next prompt) or right after
   * the agent starts. `null`/absent: nothing pending. When a role/model change is pending,
   * exactly one of `role`/`model` is non-null (`role`: a role to apply; `model`: a concrete model
   * to pin). `thinkingLevel` is independent of them. Refreshed through the existing
   * `session:list-changed` push (`onSessionListChanged`, the one `pinned`/`currentRole` ride on). */
  pendingSelection?: {
    role: string | null;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string | null;
  } | null;
  /** Lane RM (#741, #740): the role this Session is on, `null` while pinned (`ipc-model.ts`'s
   * own `ModelApi.listRoles` doc has the full reasoning). Optional, same reason as `pinned`. */
  currentRole?: string | null;
  /** #526 (FR-109): the live Activity readout, patched by `session:activity`; `null` when idle,
   * stopped, or not yet known. Optional so older fixtures still type. */
  activity?: SessionActivity | null;
}

/** `sessions.diffStat(id)` (T068, contracts/ipc.md): tracked-file edits since the merge-base
 * with the Session's Base branch, plus new untracked files. `partial` marks that the 200-file or
 * 1 MiB-per-file cap stopped counting before the real total. Defined in `./model` (spec 004:
 * `SessionReadout.changes` also needs it) and re-exported here so every existing import from
 * `../../shared/ipc` keeps working unchanged. */
export type { DiffStat } from './model';

/** Spec 015 data-model.md: defined in `./model` (not `./frames`, which is OMP-wire-frame-shaped
 * data only) and re-exported here, the same reasoning `DiffStat` above already uses, so preload
 * can import it from `../../shared/ipc` alongside every other IPC-facing type instead of a
 * second import source. */
export type { FileTreeNode, FilePreview, GitStatusMap, GitChangesSnapshot } from './model';

/** The renderer-facing copy of main's in-memory SessionRuntime (data-model.md). */
export interface SessionRuntimeView {
  sessionId: string;
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  stopDetail?: string;
  /** Issue #510 slice 2 (PLAN.md row A0): see `SessionSummary.terminatedUnexpectedly`; computed
   * the same way (`buildSnapshot`), carried here too so `sessions.open`/`sessions.recover`'s
   * stop banner can show it without a second round-trip. */
  terminatedUnexpectedly?: boolean;
  /** Tool names left without a result when `terminatedUnexpectedly` is true (quality gate
   * 2026-10-08: the stop banner names the interrupted tool instead of leaving the detected
   * detail computed-but-unused). Absent/empty when there was none to name. */
  pendingToolNames?: string[];
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null;
  unread: boolean;
  transcript: TranscriptItem[];
  queue: { followUp: string[]; steering: string[] };
  pending: PendingRequest[];
}

/** One `repositories.branches` entry for the Base branch picker (FR-002). `name` is the git branch
 * and the value `sessions.create` takes as `baseBranch`; `sessionName` and `archived` are set only
 * for `kind: 'session'`, from the owning Session's live `name` and `archivedAt`. */
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
  // spec 004 (T024 live-finding fix): the current turn's subagents, seeded here so a Subagent
  // panel re-open after any ChatPane remount (a Settings round-trip, a session switch away and
  // back) shows the real current list instead of an empty one -- subsequent changes still arrive
  // via `subagents:update`, this is only the seed `sessions.open`/`recover` itself must not drop.
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
  /** Issue #510 (quality gate 2026-10-08): set only on a live transition to `stopped`, so the
   * session-list row's "Terminated unexpectedly" text is never stale until the next unrelated
   * `sessions.list()` refresh. Quality-gate fix (cycle 3, 2026-10-08): `undefined` on a `stopped`
   * transition (for example `clearUnread`'s own status re-emit, which carries no new value at
   * all) means "not applicable to THIS transition" -- the renderer (`sessions-store.ts`'s
   * `applyStatus`, `ChatPane.tsx`'s `onSessionStatus`) keeps whatever this row/pane already
   * showed, never wipes it back to `false`. A transition to a LIVE status (working/idle/
   * needs-you) does reset it to `false`: a Session that is running is definitely not
   * "terminated". */
  terminatedUnexpectedly?: boolean;
  /** Issue #512: live while a start is in flight (`SessionRuntime.startProgress`); `undefined`
   * once it settles. Required (not optional) so `emitStatus()` omitting it is a compile error --
   * a gate-fixes Critical finding: it previously went missing from every live event, carrying
   * `startProgress: undefined` the whole time a Session was actually starting. */
  startProgress: SessionStartProgress | undefined;
  unread: boolean;
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null;
}

// Pull request management (specs/003-pull-request-management/contracts/ipc.md). Entity types
// (PullRequestSummary, PullRequestDetail, ChangedFile, FilterTab, ReviewVerdict, MergeMethod) live
// in './github', imported above; these are the per-request wrapper shapes only.

/** `pullRequests.list` (FR-001 to FR-006): the current tab's rows plus when they were fetched. */
export interface PullRequestListResult {
  items: PullRequestSummary[];
  fetchedAt: string;
}

/** `pullRequests.submitReview` (FR-015): the confirmation for 'approve'/'request-changes' happened
 * in ReviewDialog.tsx. `expectedHeadSha` is the `headSha` on screen when the dialog opened; main
 * refuses with `stale` unless it matches a fresh re-fetch taken right before the mutation, not the
 * poll-seeded cache. */
export interface SubmitReviewInput {
  verdict: Exclude<ReviewVerdict, 'dismissed'>; // dismissed: real post-submit verdict, never submittable (#568 decision 10)
  body?: string;
  expectedHeadSha: string;
}

/** `pullRequests.merge` (FR-016, FR-017): `method` must be one of the pull request's own
 * `PullRequestDetail.allowedMergeMethods`. `expectedHeadSha`: see `SubmitReviewInput`'s identical
 * reasoning -- captured when `MergeDialog` opens, checked against a fresh re-fetch, not the cache. */
export interface MergeInput {
  method: MergeMethod;
  expectedHeadSha: string;
}

/** `ipc-sessions.ts`'s own `LeftoverSummary` has the full reasoning -- split out there (issue
 * #891) to keep this file at its own file-size baseline (issue #806), re-exported here so every
 * existing import from `../../shared/ipc` keeps working unchanged. */
export type { LeftoverSummary } from './ipc-sessions';

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const IPC_REQUESTS = {
  READINESS_CHECK: 'readiness.check',
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
  SESSIONS_RECREATE_WORKTREE: 'sessions.recreateWorktree',
  SESSIONS_RECOVER: 'sessions.recover',
  SESSIONS_RESUME: 'sessions.resume',
  SESSIONS_STOP_AGENT: 'sessions.stopAgent',
  // Issue #512: dismiss the "Keep waiting?" prompt, or cancel an in-flight start outright.
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
  // Spec 015 contracts/ipc.md "File explorer": listDirectory (Slice 1), readPreview/getStatus
  // (Slice 2, above); openInVSCode/reveal/copyPath (Slice 3, below).
  FILE_EXPLORER_LIST_DIRECTORY: 'fileExplorer.listDirectory',
  FILE_EXPLORER_READ_PREVIEW: 'fileExplorer.readPreview',
  FILE_EXPLORER_GET_STATUS: 'fileExplorer.getStatus',
  FILE_EXPLORER_OPEN_IN_VSCODE: 'fileExplorer.openInVSCode',
  FILE_EXPLORER_REVEAL: 'fileExplorer.reveal',
  FILE_EXPLORER_COPY_PATH: 'fileExplorer.copyPath',
  // PR #671 gate round 7 fix (Sec7/Code7/A11y7/Verif7): the explorer's own recursive watcher
  // blocks rename/move of every ancestor of the worktree root for its whole lifetime once
  // opened -- these let the renderer stop it the instant the LAST open `FileExplorerPanel` for
  // a Session unmounts (ref-counted, since a split pane could in principle show the same
  // Session's panel twice), and restart it (without a full reload, to keep the cached
  // expansion/scroll state) the moment one mounts again.
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
  WINDOW_POPUP_MENU: 'window.popupMenu',
  PULL_REQUESTS_LIST: 'pullRequests.list',
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
  ISSUES_LABELS: 'issues.labels',
  ISSUES_SEARCH: 'issues.search',
  ISSUES_CREATE: 'issues.create',
  ISSUES_LIST: 'issues.list',
  ISSUES_VIEW: 'issues.view',
  THEME_PREVIEW: 'theme.preview',
  THEME_SET: 'theme.set',
  TOKEN_GUARD_GET: 'tokenGuard.get',
  TOKEN_GUARD_SET: 'tokenGuard.set',
  TOKEN_GUARD_RESET: 'tokenGuard.reset',
  TOKEN_GUARD_HANDOFF: 'tokenGuard.handoff',
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
  TRANSCRIPT_PATCH: 'transcript:patch',
  QUEUE_UPDATE: 'queue:update',
  REQUEST_PENDING: 'request:pending',
  REQUEST_RESOLVED: 'request:resolved',
  COMMANDS_UPDATE: 'commands:update',
  SETTINGS_CHANGED: 'settings:changed',
  UI_OPEN_SESSION: 'ui:open-session',
  MEMORY_WARNING: 'memory:warning',
  TOKEN_GUARD_LAUNCH_WARNING: 'token-guard:launch-warning',
  TOKEN_GUARD_CALLS: 'token-guard:calls',
  READOUT_UPDATE: 'readout:update',
  SUBAGENTS_UPDATE: 'subagents:update',
  ADVISOR_UPDATE: 'advisor:update',
  SESSION_HEALTH: 'session:health',
  SUBAGENT_PATCH: 'subagent:patch',
  SIDE_CHAT_PATCH: 'side-chat:patch',
  SIDE_CHAT_INTERRUPTED: 'side-chat:interrupted',
  SIDE_CHAT_CONVERSATION_CHANGED: 'side-chat:conversation-changed',
  FILE_EXPLORER_PATCH: 'file-explorer:patch',
  FILE_EXPLORER_RESET: 'file-explorer:reset',
  GIT_CHANGES_REFRESH: 'git-changes:refresh',
  ACCOUNTS_GITHUB_CHANGED: 'accounts:github-changed',
  ACCOUNTS_GITHUB_ADD_PROGRESS: 'accounts:github-add-progress',
  READINESS_INSTALL_PROGRESS: 'readiness:install-progress',
  READINESS_CHANGED: 'readiness:changed',
  UPDATES_STATE_CHANGED: 'updates:state-changed',
  REPOSITORIES_CLONE_PROGRESS: 'repositories:clone-progress',
} as const;

/** Spec 007 contracts/ipc.md "Bootstrap": the one channel that is not `Result<T>`-shaped -- a synchronous `ipcRenderer.sendSync`/`ipcMain.on`
 * pair, called once from `main.tsx` before React mounts (FR-012/SC-003, research.md decision 4, confirmed live: FINDINGS.md item 42). Kept
 * out of `IPC_REQUESTS` (async `invoke`/`handle` there) and `IPC_EVENTS` (main-pushed, no reply) since it is neither. */
export const THEME_BOOTSTRAP_CHANNEL = 'theme:bootstrap';

// ---------------------------------------------------------------------------
// window.refract
// ---------------------------------------------------------------------------

/** An unsubscribe function returned by every `on*` event subscription. */
export type Unsubscribe = () => void;

export interface RefractApi extends UpdatesApi, ImagesApi {
  repositories: RepositoriesCloneApi & {
    /** Issue #528, gate round 3 fix (Medium): returns immediately with `remote: { kind:
     * 'unknown' }` on every entry -- the per-repository remote check used to run inline here
     * and could delay this call noticeably, which `App.tsx`'s own `showReadiness` gate means
     * directly delays the Session list's first paint for anyone who already has repositories.
     * Call `remotes()` separately once this resolves to fill in the real icons. */
    list(): Promise<Result<Repository[]>>;
    add(path: string): Promise<Result<Repository>>;
    remove(id: string): Promise<Result<void>>;
    /** Issue #480: display-name only -- never touches the folder, worktrees, or branches. An
     * empty (after trimming) `name` resets to the folder's own basename. */
    rename(id: string, name: string): Promise<Result<Repository>>;
    setColor(id: string, color: ProjectColor | null): Promise<Result<Repository>>; // Issue #887: null clears; the result has no `remote`.
    /** Issue #528: the bounded remote-detection step split out of `list()` so it never gates the
     * Session list's first paint. Keyed by repository id; an id the pool's deadline cut off is
     * simply absent -- callers keep their existing value for it. Bounded per call (3s) and in
     * aggregate, concurrency-capped, no network call. */
    remotes(): Promise<Result<Record<string, RepositoryRemote>>>;
    branches(id: string): Promise<Result<BranchEntry[]>>;
    pickFolder(): Promise<Result<string | null>>;
    /** `git config user.name` in the repository's own checkout, falling back to the Windows
     * account name; cached per repository id (T072, FR-045). */
    userName(id: string): Promise<Result<string>>;
  };

  sessions: {
    list(): Promise<Result<SessionSummary[]>>;
    create(input: { repositoryId: string; baseBranch: string }): Promise<Result<Session>>;
    rename(id: string, name: string): Promise<Result<void>>;
    /** Issue #509 quality-gate fix: `userAction` (default false) bypasses `canAutoStart` exactly
     * like `recover` does, for the one case that is a genuine explicit user request rather than a
     * passive pane-open -- sending a typed message to a not-yet-started Session (MessageInput's
     * own `notStarted` path). */
    open(id: string, userAction?: boolean): Promise<Result<SessionSnapshot>>;
    archive(id: string): Promise<Result<void>>;
    restore(id: string): Promise<Result<void>>;
    setHidden(id: string, hidden: boolean): Promise<Result<void>>; // #748: view flag only, never stops the agent
    deleteCheck(id: string): Promise<Result<{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }>>;
    /** Issue #891: a background filesystem walk, separate from `deleteCheck`, listing generated
     * folders and other files the delete would remove. Can take real time against a large
     * worktree -- the Delete dialog shows "Checking files…" until it resolves and never gates
     * Delete on it. */
    deleteLeftoverSummary(id: string): Promise<Result<LeftoverSummary>>;
    delete(id: string, options: { confirmed: true }): Promise<Result<void>>;
    recreateWorktree(id: string): Promise<Result<void>>;
    recover(id: string): Promise<Result<SessionSnapshot>>;
    /** Issue #509 (PLAN.md row A2g): recover (if needed) then send `DEFAULT_RESUME_INSTRUCTION`
     * as a real turn, atomically and server-side-locked per Session id -- the single path both
     * the session-list row button and the ChatPane stop banner's Resume button call, so neither
     * can ever send the instruction twice. */
    resume(id: string): Promise<Result<SessionSnapshot>>;
    stopAgent(sessionId: string): Promise<Result<void>>;
    /** Issue #512's "Keep waiting" button: dismisses the ready-wait prompt without affecting the
     * ceiling. A no-op (still `ok: true`) if the Session is not currently starting. */
    keepWaitingForStart(sessionId: string): Promise<Result<void>>;
    /** Issue #512's "Cancel" button: fails an in-flight start immediately instead of waiting out
     * the ceiling. A no-op (still `ok: true`) if the Session is not currently starting. */
    cancelStart(sessionId: string): Promise<Result<void>>;
    /** Spec 005 contracts/ipc.md: every session id currently shown in any pane (0, 1, or 2
     * elements), replacing the single-id/`null` form. Selects which sessions' `transcript:patch`
     * events are forwarded; for each id newly present, clears its `unread` and flushes a full
     * transcript snapshot (`transcript:patch` `reset`), exactly as the single-id form did. */
    setVisible(sessionIds: string[]): Promise<Result<void>>;
    diffStat(id: string): Promise<Result<DiffStat | null>>;
    revealWorktree(id: string): Promise<Result<void>>;
    /** Issue #610: reveals a single file in the OS file explorer (`shell.showItemInFolder`),
     * never opens/executes it. `path` is untrusted chat text (a linkified file reference, agent-
     * or tool-authored) -- main resolves it only against this Session's own worktree root
     * (looked up by `sessionId`, never trusted from the renderer), rejecting anything that does
     * not resolve, after following symlinks, to the worktree itself or a real descendant of it.
     * `'outside-worktree'`/`'file-missing'`/`'worktree-missing'` are typed errors, not thrown. */
    revealFile(sessionId: string, path: string): Promise<Result<void>>;
  };

  /** `ipc-attachments.ts`'s own `AttachmentsApi` has the full reasoning -- split out there to
   * keep this file at its own file-size baseline (issue #806). */
  attachments: AttachmentsApi;

  clipboard: {
    /** Fallback for a sandboxed renderer where `navigator.clipboard.writeText` is refused
     * (`session.setPermissionRequestHandler` denies every permission): writes through main's own
     * `electron.clipboard` instead, which needs no renderer permission. */
    writeText(text: string): Promise<Result<void>>;
  };

  conversations: {
    list(sessionId: string): Promise<Result<ConversationInfo[]>>;
    startNew(sessionId: string): Promise<Result<SessionSnapshot>>;
    open(sessionId: string, file: string): Promise<Result<SessionSnapshot>>;
  };

  chat: {
    /** `images` (spec 009, FR-006): each entry already validated by the renderer's own
     * paste-time check; the main process re-validates every one independently before building
     * the outgoing command (FR-018), returning `unsupported-image-type`/`image-too-large` on the
     * first failing entry and sending nothing. */
    send(sessionId: string, text: string, images?: ImageContent[]): Promise<Result<{ queued: boolean }>>;
    stop(sessionId: string): Promise<Result<import('./stop-result').StopResult>>;
    // Issue #540: carries the queue the chip actually belongs to -- the old hard-coded
    // `'followUp'` meant a steering chip's Remove always reported `removed: false` (OMP never
    // had it in that queue), so a steering chip could never be removed at all.
    removeQueued(sessionId: string, text: string, queue: QueueKind): Promise<Result<{ removed: boolean }>>;
    /** Issue #540: implemented with OMP's atomic `promote_queued_message` (moves the message,
     * attachments included, with no reprocessing and no duplicate), replacing the old hand-made
     * remove-then-steer -- offered only for follow-up chips, since `promote_queued_message` only
     * ever matches a queued follow-up. `promoted: false` means it was no longer pending at
     * dispatch time (for example, already delivered); the caller still shows a notice rather
     * than silently doing nothing. No `images?` parameter -- OMP keeps the queued message's own
     * images with it; a resend never needs the caller's current composer images
     * (contracts/omp-usage.md "Send now (steer)"). */
    sendNow(sessionId: string, text: string): Promise<Result<{ promoted: boolean }>>;
    answer(sessionId: string, requestId: string, answer: ChatAnswer): Promise<Result<void>>;
    commands(sessionId: string): Promise<Result<SlashCommand[]>>;
    /** Ghost-text composer completion (T103, FR-058): `null` whenever there is no live agent
     * process or the server's own gating yields nothing; never rejects. */
    predictWord(sessionId: string, text: string, cursor: number): Promise<Result<string | null>>;
    /** Sent once per shown-then-resolved suggestion; `accepted: true` on Tab, `false` on
     * dismiss (Esc) or an invalidating edit. */
    predictWordFeedback(
      sessionId: string,
      text: string,
      cursor: number,
      suggestion: string,
      accepted: boolean
    ): Promise<Result<void>>;
    /** Spec 004 FR-017 to FR-020: tells main which subagent's stream to forward as
     * `subagent:patch`; `null` stops forwarding (panel closed, or no subagent selected). Mirrors
     * `sessions.setVisible`. */
    setVisibleSubagent(sessionId: string, subagentId: string | null): Promise<Result<void>>;
    /** Full current stream for one subagent (spec 004 FR-018), for when the panel first selects
     * it, before patches arrive. Error `not-found` when the id does not match a `SubagentSummary`
     * of the current turn. */
    subagentSnapshot(sessionId: string, subagentId: string): Promise<Result<TranscriptItem[]>>;
  } & ChatPauseApi;

  sideChat: {
    /** Spec 014 contracts/ipc.md "Side chat": issues `{type:"btw", question, recordId?}` to that
     * Session's OMP process. Returns the new record's own whole shape immediately (gate-fix
     * round 2: the bare id alone lost the status OMP returned, which is what left the panel
     * stuck on "Thinking" when an error or an already-terminal record raced the invoke reply);
     * the answer itself also arrives over `onSideChatPatch` as a terminal `btw_record`.
     * `recordId` omitted starts a fresh topic (FR-003). A blank `question` is rejected locally
     * with `invalid-argument` before ever reaching OMP; the >10,000-character cap is enforced
     * main-side only. */
    ask(sessionId: string, question: string, recordId?: string): Promise<Result<{ record: SideChatRecord }>>;
    /** Issues `btw_cancel` for that Session's currently-running record, if any. A no-op (not an
     * error) if nothing is running -- mirrors `subagents.cancel`'s own idempotent shape. */
    cancel(sessionId: string): Promise<Result<void>>;
    /** Issues `get_btw_history`; every record OMP has for that Session's saved session file, in
     * the order OMP returns them. Called once per Session per app run (FR-004), not polled. */
    getHistory(sessionId: string): Promise<Result<SideChatRecord[]>>;
  };

  /** `ipc-file-explorer.ts`'s own `FileExplorerApi` has the full reasoning -- split out there to
   * keep this file at its own file-size baseline (issue #806). */
  fileExplorer: FileExplorerApi;

  gitChanges: GitChangesApi;
  issues: IssuesApi;

  settings: SettingsCloneApi & {
    get(): Promise<Result<Settings>>;
    setApprovalMode(mode: ApprovalMode): Promise<Result<Settings>>;
    /** Spec 004 FR-012 to FR-014: persists the whole `Settings` row and returns this call's own
     * written value, the same race-safety pattern as `setApprovalMode`. Pushes `settings:changed`,
     * no new event. */
    setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<Result<Settings>>;
    /** Spec 005 contracts/ipc.md: persists the Split (data-model.md) to `settings.json` and
     * broadcasts `settings:changed`; `null` means no split is open. Never starts, stops, or
     * touches any agent -- this call only ever writes the stored layout. */
    setSplit(layout: SplitLayout | null): Promise<Result<Settings>>;
    /** Spec 012 FR-015 to FR-020: persists the whole `Settings` row and returns this call's own
     * written value, the same race-safety pattern as `setApprovalMode`/`setReadoutVisibility`/
     * `setSplit`. Pushes `settings:changed`, no new event. */
    setWatermarkEnabled(enabled: boolean): Promise<Result<Settings>>;
    /** Issue #457: takes ONE field at a time (a stale second toggle could otherwise revert the
     * first), merged in main against the persisted row. Pushes `settings:changed`; hiding is a
     * renderer-side view filter only -- hidden items stay in the persisted Conversation. */
    setTranscriptDisplay(field: keyof TranscriptDisplaySettings, visible: boolean): Promise<Result<Settings>>;
    /** Spec 013 FR-020 to FR-022 (contracts/ipc.md): persists the whole `Settings` row and
     * returns this call's own written value, the same race-safety pattern as
     * `setApprovalMode`/`setWatermarkEnabled` above. Pushes `settings:changed`, no new event. */
    setShowSampleData(enabled: boolean): Promise<Result<Settings>>;
    /** #514 (contracts/ipc.md): whole-row persist; `false` turns OFF path-based image-attach detection on paste (a pasted clipboard image is never affected). */
    setDetectImagePathsOnPaste(enabled: boolean): Promise<Result<Settings>>;
    setShowContextUsageBar(enabled: boolean): Promise<Result<Settings>>; // Issue #1082 (spec 004 FR-034).
    setShowAiCredits(enabled: boolean): Promise<Result<Settings>>; // #1238.
    setShowAgentStoppedBar(enabled: boolean): Promise<Result<Settings>>; // Issue #1205 (FR-107): only hides the "Agent stopped" bar; never changes history-only opening.
    setWordPredictionEnabled(enabled: boolean): Promise<Result<Settings>>; // Issue #772: absent means enabled on Electron (no Electron implementation).
    setChatWidth(width: ChatWidth): Promise<Result<Settings>>; // Issue #554 (FR-073): whole-row persist, same race-safety pattern as every other setter here. No separate preview channel -- the live preview (`chat-width-store.ts`) is renderer-local only.
    setHolidayTouches(value: HolidayTouches): Promise<Result<Settings>>; // Issue #1048: whole-row persist, same race-safety pattern as setChatWidth. Applies live, no separate preview channel.
    setAnimatedStatusText(enabled: boolean): Promise<Result<Settings>>; // Issue #1242 (FR-042): the shared status-text shimmer switch; applies live.
    setCodeLigatures(enabled: boolean): Promise<Result<Settings>>; setShowScrollbarMap(enabled: boolean): Promise<Result<Settings>>; // Issue #1246; #754 (spec 041) scrollbar map switch
    setTypography(value: NonNullable<Settings['typography']>): Promise<Result<Settings>>; // Spec 036: Rust clamps each scale to 0.8..1.5; pushes settings:changed.
    setShowFinishedTurnTimes(enabled: boolean): Promise<Result<Settings>>; // Issue #1250 (FR-119): the settled turn total switch; applies live.
    setStatusStyle(value: StatusStyle): Promise<Result<Settings>>; setChatRowDensity(value: ChatRowDensity): Promise<Result<Settings>>; setActivityText(value: ActivityText): Promise<Result<Settings>>; // #482 setStatusStyle (Appearance Status style, applies live). #526 (FR-111): same pattern as setHolidayTouches; applies live.
    setSessionListCollapse(value: SessionListCollapse): Promise<Result<Settings>>; // #735: whole-value write, same race-safety pattern as setSplit; session-list-store.ts never reads the reply or a later broadcast back into itself.
    setRightPane(value: Settings['rightPane']): Promise<Result<Settings>>; // Spec 024: sole writer is `right-pane-persistence.ts`; Rust clamps width and repairs the active tab. Pushes settings:changed.
    setPullRequestsListWidth(widthPx: number): Promise<Result<Settings>>; // #930: one width for every Project; clamped, never rejected, by SettingsStore itself. Pushes settings:changed, no new event.
  };

  /** Issue #1048 (R-lane live-check harness): debug-build-only knobs (`ipc-debug.ts`'s own
   * `DebugApi` has the full reasoning) -- split out there to keep this file at its own
   * file-size baseline (issue #806). */
  debug: DebugApi;

  /** Issue #455: reads and writes OMP's own `modelRoles` config through the `omp config` CLI,
   * never a file Refract edits itself -- always OMP's GLOBAL config.yml, never a project override. */
  modelRoles: {
    /** `omp config get modelRoles --json`: the whole record as currently assigned (role ->
     * selector); a role absent from the returned record is unset (inherits its documented
     * fallback). Can fail with `'omp-probe-failed'` (omp missing, non-zero exit, or
     * unparsable output) or `'timeout'`. */
    list(): Promise<Result<Record<string, string>>>;
    /** `omp config set modelRoles '<json>' --json`: merges `value` into the current record for
     * `role` (`null` clears/unsets it) and writes the whole record back. `overriddenBy` (when
     * present) names a higher layer -- an env var, `overlay`, or `runtime` -- that still supplies
     * the effective value despite this write succeeding. NEVER `project` IN PRACTICE: every `omp`
     * call this feature makes runs with its cwd pointed at an `fsp.mkdtemp`-randomised scratch
     * directory this module creates itself (`main/omp/config.ts`), unpredictably named and empty
     * at the moment it is created, so nothing else is ever told that path in order to plant a
     * project layer there -- confirmed live, FINDINGS item 48 (quality-gate remediation, gate
     * cycle 3 MEDIUM: this comment used to list `project` as possible, which would have meant a
     * repository's own `.omp` config can silently override what the user just picked here with no
     * visible cue; gate cycle 5 LOW, security-auditor: reworded from an absolute "no foreign
     * content can ever exist" claim -- any same-user process COULD in principle list the OS temp
     * root, find this directory by its fixed name prefix, and plant something there between calls
     * within the same session, same as it could already edit the real global `config.yml`
     * directly; this crosses no privilege boundary and is accepted, not claimed impossible).
     * Lane RM (#740): `propagation` summarises the role-change sweep over every open Session
     * on that role ("Moved N..., left M pinned, K waiting"); optional (Electron never ports
     * it). */
    set(role: ModelRoleId, value: string | null): Promise<Result<{ roles: Record<string, string>; overriddenBy?: string; propagation?: RoleChangeSummary }>>;
    /** `omp models --kind <kind> --json`: a read-only catalog listing used to populate a
     * role's model picker (the RPC `get_available_models` surface carries no role field and
     * lives behind Phase A files this feature does not touch). */
    listCatalog(kind: CatalogKind): Promise<Result<ModelCatalogEntry[]>>;
  };

  /** Lane RM (#454, #740, #741, #762, #766): per-Session model/role actions (`ipc-model.ts`'s own
   * `ModelApi` has the full reasoning); non-optional since Electron is gone (R13, gate round 1). */
  model: ModelApi;

  window: {
    /** Pops open one of the in-app menu bar's real submenus (spec 001 T100, FR-057) at `x`/`y`,
     * window-content-relative coordinates -- exactly what the clicked button's own
     * `getBoundingClientRect()` already gives. */
    popupMenu(menuId: AppMenuId, x: number, y: number): Promise<Result<void>>;
  };

  // Pull request management (specs/003-pull-request-management/contracts/ipc.md). The renderer
  // never touches `gh`, the file system, or git directly (constitution V); this namespace is the
  // only surface pull-request data crosses the renderer/main boundary through.
  pullRequests: {
    /** FR-001 to FR-006: called on open and on every explicit refresh, never polled automatically
     * (FR-028). `state` is issue #499's State control; `query` is the FR-004 narrowing filter. */
    list(repositoryId: string, tab: FilterTab, state: PullRequestStateFilter, query?: string): Promise<Result<PullRequestListResult>>;
    /** FR-007 to FR-011: called on open and again by the renderer's own polling loop while
     * `checkState === 'pending'` (FR-010); each call refreshes the main-process staleness cache. */
    detail(repositoryId: string, number: number): Promise<Result<PullRequestDetail>>;
    /** FR-012: a top-level pull request comment (plain text; rendered through the sanitiser). */
    comment(repositoryId: string, number: number, body: string): Promise<Result<{ id: string }>>;
    /** FR-013: linked to the thread's opening comment (GraphQL `inReplyTo`), never a new
     * unrelated top-level comment. */
    replyToThread(repositoryId: string, number: number, threadId: string, body: string): Promise<Result<{ id: string }>>;
    /** FR-014: a single explicit action (SC-006); reversible by `unresolveThread`. */
    resolveThread(repositoryId: string, number: number, threadId: string): Promise<Result<void>>;
    unresolveThread(repositoryId: string, number: number, threadId: string): Promise<Result<void>>;
    /** FR-015, FR-017: the renderer calls this only after its own confirmation for
     * 'approve'/'request-changes' (ReviewDialog.tsx); 'comment' needs no confirmation. */
    submitReview(repositoryId: string, number: number, input: SubmitReviewInput): Promise<Result<{ id: string }>>;
    /** FR-016, FR-017, FR-020: `method` must be one of `PullRequestDetail.allowedMergeMethods`;
     * the renderer's own confirmation (MergeDialog.tsx) names the pull request and this method. */
    merge(repositoryId: string, number: number, input: MergeInput): Promise<Result<void>>;
    /** Spec 038: closes without merging. */ close(repositoryId: string, number: number): Promise<Result<Record<string, never>>>;
    /** Spec 038, ADR 0004: allow-listed image proxy; returns a data: URL. */ fetchImage(url: string): Promise<Result<{ dataUrl: string }>>;
    /** FR-022: fetches the pull request's head branch and creates a Session exactly as
     * `sessions.create` does, substituting the fetched branch for a new one cut from a base. */
    newSessionFromPullRequest(repositoryId: string, number: number): Promise<Result<Session>>;
  };

  theme: {
    /** Spec 007 FR-003 to FR-005, FR-017: live-only, never persisted. Moves the window's
     * title-bar overlay colour to the previewed theme; `null` reverts it to the current saved
     * theme. Every other surface repaints in the renderer directly from `theme-store.ts`'s
     * derived class -- no round trip for those. */
    preview(themeId: ThemeId | null): Promise<Result<void>>;
    /** Spec 007 FR-004: persists `themeId` as the app's lasting choice (`invalid-theme` for an
     * id that is not a key of `THEMES`), applies the same title-bar overlay update, and
     * broadcasts `settings:changed`. */
    set(themeId: ThemeId): Promise<Result<Settings>>;
  };

  /** #1212 token guard: the Refract-owned values behind the `omp` launch overlay ("Set by
   * Refract" rows in Settings > OMP). A change applies to the next launched Session. `set`
   * validates the key and value per type (`invalid-argument` otherwise). */
  tokenGuard: {
    get(): Promise<Result<TokenGuardSnapshot>>;
    set(key: string, value: unknown): Promise<Result<TokenGuardSnapshot>>;
    reset(key: string): Promise<Result<TokenGuardSnapshot>>;
    handoff(sessionId: string): Promise<Result<TokenGuardHandoffResult>>;
  };

  copilot: { planUsage(): Promise<Result<{ percentUsed: number } | null>> }; // #1238; null = unavailable.

  /** Spec 007 contracts/ipc.md "Bootstrap": synchronous, called once from `main.tsx`'s very
   * first lines, before React mounts and before any class is set on `<html>`. Blocks the
   * renderer's one JS thread for one cheap call (~0.6ms, FINDINGS.md item 42) so nothing paints
   * before the right theme class is set (FR-012/SC-003). Not `Result<T>`-shaped. `typography`
   * (spec 036) carries the saved text scales for the same first-paint reason. */
  themeBootstrap(): { theme: ThemeId; typography?: Settings['typography'] };

  // Spec 008 contracts/ipc.md: GitHub accounts and OMP provider sign-in both go through the
  // developer's own CLI (GitHub CLI / omp) -- Refract never stores a token (FR-012).
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

  /** spec 008 contracts/ipc.md "Release notes": opens the installed version's GitHub release
   * page in the system browser via the same bounded, scheme-checked helper every other external
   * link already uses (constitution V); never opened inside an app window. */
  app: {
    openReleaseNotes(): Promise<Result<void>>;
    getVersion(): Promise<Result<string>>; // lane R11b (#794): for the update badge
  };

  onSessionStatus(handler: (payload: SessionStatusEvent) => void): Unsubscribe;
  onSessionActivity(handler: (payload: { sessionId: string; activity: SessionActivity | null }) => void): Unsubscribe; // #526 (FR-109)
  onSessionListChanged(handler: () => void): Unsubscribe;
  onTranscriptPatch(handler: (payload: { sessionId: string; ops: TranscriptOp[] }) => void): Unsubscribe;
  onQueueUpdate(handler: (payload: { sessionId: string; followUp: string[]; steering: string[] }) => void): Unsubscribe;
  onRequestPending(handler: (payload: { sessionId: string; request: PendingRequest }) => void): Unsubscribe;
  onRequestResolved(handler: (payload: { sessionId: string; requestId: string }) => void): Unsubscribe;
  onCommandsUpdate(handler: (payload: { sessionId: string; commands: SlashCommand[] }) => void): Unsubscribe;
  onSettingsChanged(handler: (payload: Settings) => void): Unsubscribe;
  onUiOpenSession(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onMemoryWarning(handler: (payload: LowMemoryWarning) => void): Unsubscribe;
  onTokenGuardLaunchWarning(handler: (payload: TokenGuardLaunchWarning) => void): Unsubscribe;
  onTokenGuardCalls(handler: (payload: TokenGuardCalls) => void): Unsubscribe;
  onReadoutUpdate(handler: (payload: { sessionId: string; readout: SessionReadout }) => void): Unsubscribe;
  onSubagentsUpdate(handler: (payload: { sessionId: string; subagents: SubagentSummary[] }) => void): Unsubscribe;
  onAdvisorUpdate(handler: (payload: { sessionId: string; advisorOn: boolean }) => void): Unsubscribe;
  /** Issue #561: degraded-only health; a `null` field means that measure is healthy. */
  onSessionHealth(handler: (payload: { sessionId: string; rpcSlowMs: number | null; agentMemoryBytes: number | null }) => void): Unsubscribe;
  onSubagentPatch(handler: (payload: { sessionId: string; subagentId: string; ops: TranscriptOp[] }) => void): Unsubscribe;
  onSideChatPatch(handler: (payload: { sessionId: string; delta?: string; recordId?: string; record?: SideChatRecord; notice?: string }) => void): Unsubscribe;
  /** Gate-fix (round 4, Sec4 Medium): fired whenever the Session's agent process exits, even an
   * approval-mode restart that never reaches `status: 'stopped'` -- the store's own
   * `reconcileInterrupted` marks any `running` side-chat record `interrupted` so it never blocks
   * Send/Retry/`/btw` forever. */
  onSideChatInterrupted(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  /** Gate-fix (round 5, Code5 HIGH): fired after `startNewConversation`/`openConversation`
   * confirms the Session's Conversation actually changed -- OMP's own `btw` topics are scoped
   * to the Conversation, not the Session, so the store's own `clearThread` must run here or the
   * panel keeps showing the PREVIOUS Conversation's rows and the next question sends an id the
   * new Conversation's side-chat store rejects. */
  onSideChatConversationChanged(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  /** Spec 015 contracts/ipc.md "File explorer" `FILE_EXPLORER_PATCH`: pushed whenever that
   * Session's file watcher (`fs.watch({ recursive: true })`, research.md decision 5, Slice 2
   * `src/main/fs/watchDirectory.ts`) reports a change, debounced and coalesced to one re-list of
   * the single affected directory (`relativePath`) -- never a full tree rebuild. The renderer
   * merges `entries` into `root` at `relativePath`, preserving `expandedPaths` (FR-020); dropped
   * if `relativePath` has never been fetched (not yet expanded). `truncated` (gate-fix round 5,
   * Code5 Medium) is the directory's own truncation count from the fresh listing -- the store
   * must carry it into the merged node instead of discarding it, or a >1000-entry folder's "N
   * more" row disappears after the folder's first live edit. */
  onFileExplorerPatch(
    handler: (payload: { sessionId: string; relativePath: string; entries: FileTreeNode[]; truncated: number }) => void
  ): Unsubscribe;
  /** Gate-fix (round 5, Code5 HIGH1): fired when a Session's file watcher hits a fatal error or
   * is dropped/replaced (`recreateWorktree`, an archive, a restore). The renderer's file-explorer
   * store must drop its entire `bySession[sessionId]` entry so the panel's "load root once per
   * Session" effect re-fires and a fresh watcher is re-established on the next
   * `listDirectory('')` -- otherwise the panel shows a stale tree forever with no watcher. */
  onFileExplorerReset(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onGitChangesRefresh(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onAccountsGithubChanged(handler: (payload: GitHubAccount[]) => void): Unsubscribe;
  onAccountsGithubAddProgress(handler: (payload: GitHubAddFlowProgress) => void): Unsubscribe;
}

declare global {
  interface Window {
    refract: RefractApi;
  }
}
