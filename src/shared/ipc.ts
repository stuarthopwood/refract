// Contract for the renderer-to-main typed IPC, per
// specs/001-core-session-workspace/contracts/ipc.md. Imported by main, preload, and
// renderer; this is the only file that may cross that boundary (constitution V).

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
  Repository,
  RepositoryRemote,
  Session,
  SessionReadout,
  SessionStartProgress,
  SessionStatus,
  Settings,
  SplitLayout,
  SubagentSummary,
  TranscriptDisplaySettings,
  TranscriptItem,
} from './model';
import type { ImageContent, QueueKind, SideChatRecord, SlashCommandDescriptor } from './frames';
import type {
  ChangedFile,
  FilterTab,
  MergeMethod,
  PullRequestDetail,
  PullRequestSummary,
  ReviewVerdict
} from './github';
import type { ThemeId } from './themes';

/** The four top-level items of the in-app menu bar (spec 001 T100, FR-057): `window.popupMenu`
 * asks main to pop open the one real `Menu` (`src/main/menu.ts`) built from this same set, so a
 * dev-only item (Reload, Force Reload, Toggle Developer Tools) is included or not by the one menu
 * main already builds, never a second renderer-side copy of that decision. The one shared list of
 * ids: `src/main/menu.ts` tags each template item with a matching `id` (looked up via
 * `Menu.getMenuItemById`, never by display label), `AppMenuBar.tsx` derives its own button list
 * from it, and `src/main/ipc/window.ts` validates incoming ids against it -- a single source
 * instead of three hand-maintained copies. */
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
  | 'session-archived';

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
export type { FileTreeNode, FilePreview, GitStatusMap } from './model';

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
}

export type TranscriptOp = { op: 'upsert'; item: TranscriptItem } | { op: 'reset'; items: TranscriptItem[] };

export type SlashCommand = SlashCommandDescriptor;

export type ChatAnswer = { approve: boolean } | { value: string } | { confirmed: boolean } | { cancelled: true };

export interface LowMemoryWarning {
  low: boolean;
  freeBytes: number;
  liveAgents: number;
}

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

/** spec 008 data-model.md: one GitHub CLI account across every signed-in host; never includes
 * a token (FR-012, constitution V). `displayName`/`avatarDataUrl` come from `profileCache.json`,
 * refreshed opportunistically (research.md decision 5) -- both `null` until first fetched, in
 * which case the UI shows `login` and initials respectively. */
export interface GitHubAccount {
  host: string;
  login: string;
  active: boolean;
  state: string;
  /** Why `state` is not 'success', classified in the main process from gh's own per-account error
   * text (never shown raw): the token was rejected, gh could not reach the host, or the cause is
   * unknown. Absent when `state` is 'success'. */
  problem?: 'expired' | 'unreachable' | 'unknown';
  displayName: string | null;
  avatarDataUrl: string | null;
}

/** spec 008 data-model.md, User Story 3: one OMP provider's sign-in state, read live from
 * `get_login_providers` over a scratch management `OmpProcess` -- never persisted (contracts/
 * ipc.md "OMP provider sign-in"), unlike `GitHubAccount`'s cached display fields. */
export interface OmpProviderState {
  id: string;
  authenticated: boolean;
}

/** spec 008 contracts/ipc.md `accounts:github-add-progress`: the add-account flow's one-time
 * code and progress (FR-009), pushed until the flow completes, is cancelled, or fails. */
export interface GitHubAddFlowProgress {
  flowId: string;
  code: string;
  status: 'waiting' | 'completed' | 'cancelled' | 'failed';
  detail?: string;
}

// Pull request management (specs/003-pull-request-management/contracts/ipc.md). Entity types
// (PullRequestSummary, PullRequestDetail, ChangedFile, FilterTab, ReviewVerdict, MergeMethod) live
// in './github', imported above; these are the per-request wrapper shapes only.

/** `pullRequests.list` (FR-001 to FR-006): the current tab's rows plus when they were fetched. */
export interface PullRequestListResult {
  items: PullRequestSummary[];
  fetchedAt: string;
}

/** `pullRequests.submitReview` (FR-015): the caller-side confirmation for 'approve'/'request-changes'
 * already happened (ReviewDialog.tsx) before this is ever sent; 'comment' needs no confirmation.
 * Security remediation (round 3, High): `expectedHeadSha` is the pull request's `headSha` the
 * renderer had on screen the MOMENT the dialog opened (captured before the 15s background poll
 * can silently overwrite it) -- main refuses with `stale` unless this matches a FRESH re-fetch's
 * `headSha` taken right before the mutation, not just whatever the in-process staleness cache
 * happens to hold (which the poll keeps re-seeding even while the dialog is open). */
export interface SubmitReviewInput {
  verdict: ReviewVerdict;
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

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const IPC_REQUESTS = {
  READINESS_CHECK: 'readiness.check',
  REPOSITORIES_LIST: 'repositories.list',
  REPOSITORIES_ADD: 'repositories.add',
  REPOSITORIES_REMOVE: 'repositories.remove',
  REPOSITORIES_RENAME: 'repositories.rename',
  REPOSITORIES_BRANCHES: 'repositories.branches',
  REPOSITORIES_REMOTES: 'repositories.remotes',
  REPOSITORIES_PICK_FOLDER: 'repositories.pickFolder',
  REPOSITORIES_USER_NAME: 'repositories.userName',
  SESSIONS_LIST: 'sessions.list',
  SESSIONS_CREATE: 'sessions.create',
  SESSIONS_RENAME: 'sessions.rename',
  SESSIONS_OPEN: 'sessions.open',
  SESSIONS_ARCHIVE: 'sessions.archive',
  SESSIONS_RESTORE: 'sessions.restore',
  SESSIONS_DELETE_CHECK: 'sessions.deleteCheck',
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
  CLIPBOARD_WRITE_TEXT: 'clipboard.writeText',
  CONVERSATIONS_LIST: 'conversations.list',
  CONVERSATIONS_START_NEW: 'conversations.startNew',
  CONVERSATIONS_OPEN: 'conversations.open',
  CHAT_SEND: 'chat.send',
  CHAT_STOP: 'chat.stop',
  CHAT_REMOVE_QUEUED: 'chat.removeQueued',
  CHAT_SEND_NOW: 'chat.sendNow',
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
  SETTINGS_GET: 'settings.get',
  SETTINGS_SET_APPROVAL_MODE: 'settings.setApprovalMode',
  SETTINGS_SET_READOUT_VISIBILITY: 'settings.setReadoutVisibility',
  SETTINGS_SET_SPLIT: 'settings.setSplit',
  SETTINGS_SET_WATERMARK_ENABLED: 'settings.setWatermarkEnabled',
  SETTINGS_SET_TRANSCRIPT_DISPLAY: 'settings.setTranscriptDisplay',
  SETTINGS_SET_SHOW_SAMPLE_DATA: 'settings.setShowSampleData',
  MODEL_ROLES_LIST: 'modelRoles.list',
  MODEL_ROLES_SET: 'modelRoles.set',
  MODEL_ROLES_LIST_CATALOG: 'modelRoles.listCatalog',
  WINDOW_POPUP_MENU: 'window.popupMenu',
  PULL_REQUESTS_LIST: 'pullRequests.list',
  PULL_REQUESTS_DETAIL: 'pullRequests.detail',
  PULL_REQUESTS_COMMENT: 'pullRequests.comment',
  PULL_REQUESTS_REPLY_TO_THREAD: 'pullRequests.replyToThread',
  PULL_REQUESTS_RESOLVE_THREAD: 'pullRequests.resolveThread',
  PULL_REQUESTS_UNRESOLVE_THREAD: 'pullRequests.unresolveThread',
  PULL_REQUESTS_SUBMIT_REVIEW: 'pullRequests.submitReview',
  PULL_REQUESTS_MERGE: 'pullRequests.merge',
  PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST: 'pullRequests.newSessionFromPullRequest',
  THEME_PREVIEW: 'theme.preview',
  THEME_SET: 'theme.set',
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
} as const;

export const IPC_EVENTS = {
  SESSION_STATUS: 'session:status',
  SESSION_LIST_CHANGED: 'session:list-changed',
  TRANSCRIPT_PATCH: 'transcript:patch',
  QUEUE_UPDATE: 'queue:update',
  REQUEST_PENDING: 'request:pending',
  REQUEST_RESOLVED: 'request:resolved',
  COMMANDS_UPDATE: 'commands:update',
  SETTINGS_CHANGED: 'settings:changed',
  UI_OPEN_SESSION: 'ui:open-session',
  MEMORY_WARNING: 'memory:warning',
  READOUT_UPDATE: 'readout:update',
  SUBAGENTS_UPDATE: 'subagents:update',
  SUBAGENT_PATCH: 'subagent:patch',
  SIDE_CHAT_PATCH: 'side-chat:patch',
  SIDE_CHAT_INTERRUPTED: 'side-chat:interrupted',
  SIDE_CHAT_CONVERSATION_CHANGED: 'side-chat:conversation-changed',
  FILE_EXPLORER_PATCH: 'file-explorer:patch',
  FILE_EXPLORER_RESET: 'file-explorer:reset',
  ACCOUNTS_GITHUB_CHANGED: 'accounts:github-changed',
  ACCOUNTS_GITHUB_ADD_PROGRESS: 'accounts:github-add-progress',
} as const;

/** Spec 007 contracts/ipc.md "Bootstrap": the one channel in the app that is not
 * `Result<T>`-shaped -- a synchronous `ipcRenderer.sendSync` request/response pair answered by a
 * synchronous `ipcMain.on` handler, called once from `main.tsx`'s very first lines before React
 * mounts (FR-012/SC-003, research.md decision 4, confirmed live: FINDINGS.md item 42). Kept out
 * of `IPC_REQUESTS` (every other entry there is `ipcMain.handle`/`ipcRenderer.invoke`, async) and
 * out of `IPC_EVENTS` (main-pushed, no reply) since it is neither. */
export const THEME_BOOTSTRAP_CHANNEL = 'theme:bootstrap';

// ---------------------------------------------------------------------------
// window.refract
// ---------------------------------------------------------------------------

/** An unsubscribe function returned by every `on*` event subscription. */
export type Unsubscribe = () => void;

export interface RefractApi {
  readiness: {
    check(): Promise<Result<Readiness>>;
  };

  repositories: {
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
    /** Issue #528, gate round 3 fix (Medium): the bounded remote-detection step `list()` used
     * to run inline, now split out so it never gates the Session list's first paint. Keyed by
     * repository id; a repository the shared pool's own deadline cut off mid-flight (gate round
     * 4 fix, High: no longer sent as a false `unknown` placeholder) is simply absent from the
     * response -- callers should leave their own existing value for an id not present here,
     * never treat the absence itself as meaningful. Bounded per call (3s) and in aggregate
     * (`src/main/ipc/repositories.ts`'s own pool/deadline, now generous since this is off the
     * first-paint path), concurrency-capped, no network call. */
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
    deleteCheck(id: string): Promise<Result<{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }>>;
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
    stop(sessionId: string): Promise<Result<void>>;
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
  };

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

  fileExplorer: {
    /** Spec 015 contracts/ipc.md "File explorer" (FR-001, FR-004 to FR-007, T004/T005): lists
     * one directory's immediate children only (lazy-load, FR-005 -- never recurses), folders
     * before files then alphabetical within each group (FR-006). `relativePath` `''` lists the
     * worktree root itself (FR-004); any other value is resolved against that Session's
     * worktree root through `resolveInWorktree` (`src/main/ipc/files.ts`, issue #610's own
     * already-hardened containment check, reused unchanged here rather than a second
     * implementation) and MUST stay inside it after resolving symlinks/junctions, or the call
     * fails `outside-worktree` rather than reading outside it. `.git` itself is never returned
     * as an entry (FR-007). `truncated` (Slice 2, PR #671 gate round 2 fix, security-auditor/
     * code-reviewer LOW) is the count of entries past a main-side cap on how many this one
     * directory ever returns -- enforced in main BEFORE any per-entry symlink classification
     * work runs, not only by the renderer's own virtualisation, so a pathologically huge
     * directory can never force unbounded `readlink`/`stat` work; `0` means nothing was cut.
     * No git-status/ignore filtering here (Slice 2, FR-009 to FR-011) -- that is `getStatus`
     * below, merged in by the renderer, never part of this response. */
    listDirectory(sessionId: string, relativePath: string): Promise<Result<{ entries: FileTreeNode[]; truncated: number }>>;
    /** Spec 015 Slice 2 (FR-012 to FR-015, FR-002/FR-003, data-model.md `FilePreview`): reads one
     * file's preview data. Same path-containment check and error codes as `listDirectory`
     * (`resolveInWorktree`, reused unchanged). Binary detection is by content (a NUL byte in a
     * capped header slice, reusing `diffStat.ts`'s own `isBinary` heuristic), never by
     * extension; an image is detected by magic bytes, also never by extension (FR-014). A file
     * over the preview size cap returns `kind: 'too-large'` with `size` set, never a partial
     * read (FR-002, SC-001). */
    readPreview(sessionId: string, relativePath: string): Promise<Result<{ preview: FilePreview }>>;
    /** Spec 015 Slice 2 (FR-010, FR-011, data-model.md `GitStatusMap`): issues the single shared
     * git-status/ignore reader (research.md decisions 2 and 6) once for the whole worktree; the
     * renderer merges this into every currently-loaded node's `gitStatus` rather than calling
     * per-path. `null` on any failure (no git repo, git unavailable, timeout) -- never thrown,
     * mirrors `diffStat.ts`'s own never-throw-into-renderer convention; the tree still renders
     * with no status marks in that case. Built for reuse by #464 (FR-011) -- this method's shape
     * is intentionally generic (a full map, not scoped to the explorer's own currently-expanded
     * paths). */
    getStatus(sessionId: string): Promise<Result<{ status: GitStatusMap | null }>>;
    /** Spec 015 Slice 3 (FR-016, FR-017, research.md decision 1): resolves `Code.exe` via the
     * dedicated fixed-install-root resolver (never `resolveExecutable('code')`/`code.cmd`, never
     * `shell: true`) and spawns it with an absolute-path args array. `{ opened: false }` when no
     * known install root resolves -- a normal result, not an IPC error, so the renderer shows the
     * "VS Code not found" state inline rather than a toast. No silent fallback to any other
     * launcher. */
    openInVSCode(sessionId: string, relativePath: string): Promise<Result<{ opened: boolean }>>;
    /** Spec 015 Slice 3 (FR-018): reveals one file in the OS file explorer via
     * `shell.showItemInFolder`, the exact same hardened pattern `sessions.revealFile` (issue
     * #610) already established -- deliberately NEVER `shell.openPath`, which runs a file's own
     * default verb (a `.cmd`/`.ps1`/`.lnk`/`.js` an agent or tool wrote would execute). */
    reveal(sessionId: string, relativePath: string): Promise<Result<void>>;
    /** Spec 015 Slice 3 (FR-018): writes the file's absolute path to the clipboard. The renderer
     * tries `navigator.clipboard.writeText` itself first (`useWorktreeActions.ts`'s own
     * fallback pattern) and only calls this when the sandboxed renderer refuses it. Error
     * `clipboard-failed` on a main-process clipboard write failure. */
    copyPath(sessionId: string, relativePath: string): Promise<Result<void>>;
  };

  settings: {
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
    /** Issue #457, quality-gate remediation (HIGH): takes ONE field at a time (not the whole
     * `TranscriptDisplaySettings` object -- a quick second toggle sent with the renderer's
     * stale pre-write value of the first field could otherwise revert it), merged in main
     * against the persisted row, the same per-field pattern `setReadoutVisibility` already
     * uses. Returns this call's own written value, the same race-safety pattern as every other
     * setter here. Pushes `settings:changed`, no new event. Hiding is a renderer-side view
     * filter only -- hidden items stay in the persisted Conversation.
     */
    setTranscriptDisplay(field: keyof TranscriptDisplaySettings, visible: boolean): Promise<Result<Settings>>;
    /** Spec 013 FR-020 to FR-022 (contracts/ipc.md): persists the whole `Settings` row and
     * returns this call's own written value, the same race-safety pattern as
     * `setApprovalMode`/`setWatermarkEnabled` above. Pushes `settings:changed`, no new event. */
    setShowSampleData(enabled: boolean): Promise<Result<Settings>>;
  };

  /** Issue #455: reads and writes OMP's own `modelRoles` config through the `omp config` CLI
   * (`src/main/omp/config.ts`), never a file Refract edits itself -- `omp config set` always
   * writes OMP's GLOBAL config.yml (`omp://settings.md` "Where writes go"), never a project
   * override. */
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
     * directly; this crosses no privilege boundary and is accepted, not claimed impossible). */
    set(role: ModelRoleId, value: string | null): Promise<Result<{ roles: Record<string, string>; overriddenBy?: string }>>;
    /** `omp models --kind <kind> --json`: a read-only catalog listing used to populate a
     * role's model picker (the RPC `get_available_models` surface carries no role field and
     * lives behind Phase A files this feature does not touch). */
    listCatalog(kind: CatalogKind): Promise<Result<ModelCatalogEntry[]>>;
  };

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
     * (FR-028). `query` is the FR-004 narrowing filter. */
    list(repositoryId: string, tab: FilterTab, query?: string): Promise<Result<PullRequestListResult>>;
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

  /** Spec 007 contracts/ipc.md "Bootstrap": synchronous, called once from `main.tsx`'s very
   * first lines, before React mounts and before any class is set on `<html>` -- replaces the old
   * hardcoded `document.documentElement.classList.add('dark')`. Blocks the renderer's single JS
   * thread for one cheap, one-time call (confirmed live at ~0.6ms, FINDINGS.md item 42) so
   * nothing paints before the right theme class is already set (FR-012/SC-003). Not
   * `Result<T>`-shaped: there is nothing to fail. */
  themeBootstrap(): { theme: ThemeId };

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
  };
  onSessionStatus(handler: (payload: SessionStatusEvent) => void): Unsubscribe;
  onSessionListChanged(handler: () => void): Unsubscribe;
  onTranscriptPatch(handler: (payload: { sessionId: string; ops: TranscriptOp[] }) => void): Unsubscribe;
  onQueueUpdate(handler: (payload: { sessionId: string; followUp: string[]; steering: string[] }) => void): Unsubscribe;
  onRequestPending(handler: (payload: { sessionId: string; request: PendingRequest }) => void): Unsubscribe;
  onRequestResolved(handler: (payload: { sessionId: string; requestId: string }) => void): Unsubscribe;
  onCommandsUpdate(handler: (payload: { sessionId: string; commands: SlashCommand[] }) => void): Unsubscribe;
  onSettingsChanged(handler: (payload: Settings) => void): Unsubscribe;
  onUiOpenSession(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onMemoryWarning(handler: (payload: LowMemoryWarning) => void): Unsubscribe;
  onReadoutUpdate(handler: (payload: { sessionId: string; readout: SessionReadout }) => void): Unsubscribe;
  onSubagentsUpdate(handler: (payload: { sessionId: string; subagents: SubagentSummary[] }) => void): Unsubscribe;
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
  /** Gate-fix (round 5, Code5 HIGH1): fired when a Session's file watcher hits a fatal error
   * (watched root deleted/moved out from under it, `watchDirectory.ts`'s `onFatal`) or when
   * `sessions.ts` drops/replaces the watcher after `recreateWorktree` succeeds, an archive, or a
   * restore. The renderer's file-explorer store must drop its entire `bySession[sessionId]`
   * entry so the panel's "load root once per Session" effect naturally re-fires and a fresh
   * watcher is re-established on the next `listDirectory('')` -- without this the panel keeps
   * showing a stale tree forever with no watcher running underneath it. */
  onFileExplorerReset(handler: (payload: { sessionId: string }) => void): Unsubscribe;
  onAccountsGithubChanged(handler: (payload: GitHubAccount[]) => void): Unsubscribe;
  onAccountsGithubAddProgress(handler: (payload: GitHubAddFlowProgress) => void): Unsubscribe;
}

declare global {
  interface Window {
    refract: RefractApi;
  }
}
