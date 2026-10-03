// Contract for the renderer-to-main typed IPC, per
// specs/001-core-session-workspace/contracts/ipc.md. Imported by main, preload, and
// renderer; this is the only file that may cross that boundary (constitution V).

import type { ApprovalMode, ConversationInfo, PendingRequest, Repository, Session, SessionStatus, Settings, TranscriptItem } from './model';
import type { SlashCommandDescriptor } from './frames';

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
  | 'branch-missing'
  | 'not-found'
  | 'invalid-argument'
  | 'prompt-failed'
  | 'agent-not-running'
  | 'worktree-missing'
  | 'clipboard-failed';

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

/** `sessions.list()` row: a Session plus its live-runtime view. */
export interface SessionSummary extends Session {
  status: SessionStatus;
  /** T043: surfaces `worktree-missing`/`not-started` in the list row itself, so a missing
   * worktree shows a distinct badge without opening the Session. */
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  unread: boolean;
  pendingMode: ApprovalMode | null;
}

/** `sessions.diffStat(id)` (T068, contracts/ipc.md): tracked-file edits since the merge-base
 * with the Session's Base branch, plus new untracked files. `partial` marks that the 200-file or
 * 1 MiB-per-file cap stopped counting before the real total. */
export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
  partial: boolean;
}

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
  SETTINGS_GET: 'settings.get',
  SETTINGS_SET_APPROVAL_MODE: 'settings.setApprovalMode',
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
    setVisible(sessionId: string | null): Promise<Result<void>>;
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
    send(sessionId: string, text: string): Promise<Result<{ queued: boolean }>>;
    stop(sessionId: string): Promise<Result<void>>;
    removeQueued(sessionId: string, text: string): Promise<Result<{ removed: boolean }>>;
    sendNow(sessionId: string, text: string): Promise<Result<{ steered: boolean }>>;
    answer(sessionId: string, requestId: string, answer: ChatAnswer): Promise<Result<void>>;
    commands(sessionId: string): Promise<Result<SlashCommand[]>>;
  };

  settings: {
    get(): Promise<Result<Settings>>;
    setApprovalMode(mode: ApprovalMode): Promise<Result<Settings>>;
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
}

declare global {
  interface Window {
    refract: RefractApi;
  }
}
