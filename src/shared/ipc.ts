// Contract for the renderer-to-main typed IPC, per
// specs/001-core-session-workspace/contracts/ipc.md. Imported by main, preload, and
// renderer; this is the only file that may cross that boundary (constitution V).

import type { ApprovalMode, ConversationInfo, DiffStat, PendingRequest, ReadoutKind, Repository, Session, SessionReadout, SessionStatus, Settings, SplitLayout, SubagentSummary, TranscriptItem } from './model';
import type { ImageContent, SlashCommandDescriptor } from './frames';

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
  | 'session-running'
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
  | 'clipboard-failed'
  | 'unsupported-image-type'
  | 'image-too-large';

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

/** The renderer-facing copy of main's in-memory SessionRuntime (data-model.md). */
export interface SessionRuntimeView {
  sessionId: string;
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  stopDetail?: string;
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
  unread: boolean;
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null;
}

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const IPC_REQUESTS = {
  READINESS_CHECK: 'readiness.check',
  REPOSITORIES_LIST: 'repositories.list',
  REPOSITORIES_ADD: 'repositories.add',
  REPOSITORIES_REMOVE: 'repositories.remove',
  REPOSITORIES_BRANCHES: 'repositories.branches',
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
  SESSIONS_STOP_AGENT: 'sessions.stopAgent',
  SESSIONS_SET_VISIBLE: 'sessions.setVisible',
  SESSIONS_DIFF_STAT: 'sessions.diffStat',
  SESSIONS_REVEAL_WORKTREE: 'sessions.revealWorktree',
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
  SETTINGS_GET: 'settings.get',
  SETTINGS_SET_APPROVAL_MODE: 'settings.setApprovalMode',
  SETTINGS_SET_READOUT_VISIBILITY: 'settings.setReadoutVisibility',
  SETTINGS_SET_SPLIT: 'settings.setSplit',
  WINDOW_POPUP_MENU: 'window.popupMenu',
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
} as const;

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
    list(): Promise<Result<Repository[]>>;
    add(path: string): Promise<Result<Repository>>;
    remove(id: string): Promise<Result<void>>;
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
    open(id: string): Promise<Result<SessionSnapshot>>;
    archive(id: string): Promise<Result<void>>;
    restore(id: string): Promise<Result<void>>;
    deleteCheck(id: string): Promise<Result<{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }>>;
    delete(id: string, options: { confirmed: true }): Promise<Result<void>>;
    recreateWorktree(id: string): Promise<Result<void>>;
    recover(id: string): Promise<Result<SessionSnapshot>>;
    stopAgent(sessionId: string): Promise<Result<void>>;
    /** Spec 005 contracts/ipc.md: every session id currently shown in any pane (0, 1, or 2
     * elements), replacing the single-id/`null` form. Selects which sessions' `transcript:patch`
     * events are forwarded; for each id newly present, clears its `unread` and flushes a full
     * transcript snapshot (`transcript:patch` `reset`), exactly as the single-id form did. */
    setVisible(sessionIds: string[]): Promise<Result<void>>;
    diffStat(id: string): Promise<Result<DiffStat | null>>;
    revealWorktree(id: string): Promise<Result<void>>;
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
    removeQueued(sessionId: string, text: string): Promise<Result<{ removed: boolean }>>;
    /** High remediation (spec 009 quality gate): no `images?` parameter -- a resend must carry
     * the queued message's OWN images, recorded by `SessionAgent` at the moment it was queued,
     * never whatever the caller's composer happens to have pending right now (contracts/ipc.md). */
    sendNow(sessionId: string, text: string): Promise<Result<{ steered: boolean }>>;
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
  };

  window: {
    /** Pops open one of the in-app menu bar's real submenus (spec 001 T100, FR-057) at `x`/`y`,
     * window-content-relative coordinates -- exactly what the clicked button's own
     * `getBoundingClientRect()` already gives. */
    popupMenu(menuId: AppMenuId, x: number, y: number): Promise<Result<void>>;
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
}

declare global {
  interface Window {
    refract: RefractApi;
  }
}
