// Data stored or held by Pinion, and the shapes Pinion derives from OMP.
// Field names and literal unions follow specs/001-core-session-workspace/data-model.md exactly.

/** A local git project the developer has added to Pinion. Owns zero or more Sessions. */
export interface Repository {
  id: string; // uuid
  path: string; // absolute path of the main checkout
  name: string; // folder name, shown as the list group title
  defaultBranch: string; // read from git when added; preselected as Base branch
  addedAt: string; // ISO 8601
}

/** One unit of work: a Worktree together with the Conversations held in it. */
export interface Session {
  id: string; // uuid
  repositoryId: string;
  name: string; // display label; renamable; never affects branch or folder
  branch: string; // generated, e.g. "swift-otter"
  baseBranch: string; // branch it was created from
  worktreePath: string; // absolute; also the agent's cwd
  sessionDir: string | null; // OMP's session directory for that cwd; null until first learned
  currentConversation: string | null; // absolute path of the current Conversation's file; null before the first message
  lastMessageCount: number | null; // messageCount at the last settle; used to verify a reattach
  createdAt: string;
  lastActivityAt: string;
  archivedAt: string | null; // non-null = archived
}

/** The app-wide setting for how much the agent may do without asking. Reads are never prompted. */
export type ApprovalMode = 'ask' | 'edit-freely' | 'auto';

export interface Settings {
  version: 1;
  approvalMode: ApprovalMode; // default 'ask'
}

/** Maps Settings.approvalMode to the value OMP's `--approval-mode` flag expects. */
export const OMP_APPROVAL_MODE: Record<ApprovalMode, string> = {
  ask: 'always-ask',
  'edit-freely': 'write',
  auto: 'yolo',
};

/** One record per running `omp` root process; the pid-and-start-time fallback for stale process reaping. */
export interface ProcessRecord {
  pid: number;
  startTime: string;
  sessionId: string;
}

/** The full contents of `registry.json`. */
export interface Registry {
  version: 1;
  repositories: Repository[];
  sessions: Session[];
}

export type SessionStatus = 'idle' | 'working' | 'needs-you' | 'stopped';

/** Held in memory: one per Session with a live or recently live agent. */
export interface SessionRuntime {
  sessionId: string;
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  stopDetail?: string; // exit code, missing path, or setup message
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null; // set while a mode change waits for idle
  unread: boolean;
  transcript: TranscriptItem[]; // current Conversation, normalised
  queue: { followUp: string[]; steering: string[] }; // mirrors OMP queue_update
  pending: PendingRequest[]; // approvals and questions waiting for the user
}

/** Built in the main process from OMP frames; the renderer only renders items. */
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; at: number }
  | { kind: 'assistant-text'; id: string; text: string; streaming: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming: boolean } // omitted when the text is empty
  | {
      kind: 'tool';
      id: string;
      toolCallId: string;
      tool: string;
      target: string;
      status: 'running' | 'done' | 'error';
      startedAt: number;
      durationMs?: number;
      args: unknown;
      output?: string;
      diff?: string;
      /** From an `edit` tool's `tool_execution_end` `result.details`; the renderer builds the unified diff (T025). */
      edit?: { path: string; oldText: string; newText: string };
      /** From a `write` tool's args; the renderer diffs it against a cached prior read/edit of the same path (T025). */
      write?: { path: string; content: string };
    }
  | { kind: 'request'; id: string; requestId: string; resolved?: 'approved' | 'denied' | 'answered' | 'cancelled' }
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string };

/** `requestId` is the `id` of the OMP `extension_ui_request`. Does not survive a process restart. */
export type PendingRequest =
  | { kind: 'approval'; requestId: string; tool: string; target: string; details: string[] }
  | {
      kind: 'question';
      requestId: string;
      title: string;
      message?: string;
      options: string[];
      optionDetails?: (string | undefined)[];
      inputKind: 'choice' | 'text' | 'confirm';
    };

/** Derived from OMP by scanning `Session.sessionDir` for `*.jsonl` files; not stored by Pinion. */
export interface ConversationInfo {
  file: string; // absolute path
  id: string; // the UUID suffix of the file name
  createdAt: string; // ISO timestamp prefix of the file name (no file open needed)
  title: string; // `title` field of the first line of the file, may be empty
  preview: string; // first user message, truncated to 120 characters
  isCurrent: boolean; // file === Session.currentConversation
}
