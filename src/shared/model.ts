// Data stored or held by Refract, and the shapes Refract derives from OMP.
// Field names and literal unions follow specs/001-core-session-workspace/data-model.md exactly.

import type { ThemeId } from './themes';

/** A local git project the developer has added to Refract. Owns zero or more Sessions. */
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
  // T062: last known model/thinking level from `get_state`, persisted (registry-backed), not only
  // live-runtime state -- absent means unknown (never started, or no `get_state` has reported one
  // yet), not "no model". Written by `SessionAgent.syncFromState` at session start and after every
  // settle; never cleared when the agent stops, so they remain the last-known values across a
  // Stop or an app restart.
  lastModel?: { provider: string; id: string; name?: string };
  lastThinkingLevel?: string;
  createdAt: string;
  lastActivityAt: string;
  archivedAt: string | null; // non-null = archived
}

/** The app-wide setting for how much the agent may do without asking. Reads are never prompted. */
export type ApprovalMode = 'ask' | 'edit-freely' | 'auto';

/** One readout chip kind (spec 004 FR-001 to FR-010, FR-021); the chip row's own order. */
export type ReadoutKind =
  | 'changes'
  | 'context-usage'
  | 'turn-time'
  | 'current-time'
  | 'pull-request'
  | 'subagents'
  | 'todo-progress';

export interface Settings {
  version: 1;
  approvalMode: ApprovalMode; // default 'ask'
  sessionReadout: Record<ReadoutKind, boolean>; // spec 004 FR-012 to FR-014
  split: SplitLayout | null; // spec 005: null = single pane, no split open
  theme: ThemeId; // spec 007 FR-018: default 'dark'
  watermarkEnabled: boolean; // spec 012 FR-015 to FR-020: default true
}

/** Spec 005 data-model.md: the app-wide split layout, persisted in `Settings.split`. Holds the
 * two Session ids shown (left pane first), the divider position, and which pane was focused;
 * there is no one-element form -- closing a pane simply sets `Settings.split` back to `null`. */
export interface SplitLayout {
  sessionIds: [string, string]; // the two Session ids shown, left pane first
  dividerPercent: number; // 0-100, percentage of the chat area width the left pane takes
  focusedIndex: 0 | 1; // which of sessionIds[0]/sessionIds[1] was focused
}

/** Defaults (spec 004 FR-013): every kind on except Current time. */
export const DEFAULT_SESSION_READOUT: Record<ReadoutKind, boolean> = {
  changes: true,
  'context-usage': true,
  'turn-time': true,
  'current-time': false,
  'pull-request': true,
  subagents: true,
  'todo-progress': true,
};

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
  turnStartedAt: number | null; // spec 004: epoch ms; set on agent_start, cleared on session_settled/stop
  readout: SessionReadout; // spec 004: last assembled bundle; never persisted
  subagents: SubagentSummary[]; // spec 004: current turn's subagents; cleared when a new turn starts
}

/** `sessions.diffStat(id)` (T068, contracts/ipc.md): tracked-file edits since the merge-base
 * with the Session's Base branch, plus new untracked files. `partial` marks that the 200-file or
 * 1 MiB-per-file cap stopped counting before the real total. Re-exported from `./ipc` so every
 * existing import from `../../shared/ipc` keeps working unchanged. */
export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
  partial: boolean;
}

/** Spec 004 FR-002 to FR-008, FR-021: the chip row's live data, assembled in main
 * (`src/main/omp/readout.ts`) and pushed via `readout:update`. Current time is deliberately
 * absent: it is a pure client clock the renderer computes itself (FR-005). */
export interface SessionReadout {
  changes: DiffStat | 'not-available' | null; // DiffStat is spec 001 sessions.diffStat's return shape; null = not yet read
  contextUsage: ContextUsage | 'not-available' | null; // null = agent does not report it at all (hidden, not shown)
  turnTime: { startedAt: number } | null; // null = no turn running (chip hidden)
  pullRequest: { number: number; url: string } | null; // null = none, no remote, lookup failed, or GitHub unavailable
  subagentCount: { running: number; finished: number } | null; // null = turn has started none (chip hidden); excludes failed, folds a seeded 'exited' (#489) into finished
  todoProgress: { done: number; total: number } | null; // null = agent has no task list (chip hidden)
}

/** `get_state().contextUsage` (FINDINGS item 34): OMP reports `percent` itself, never derived here. */
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  percent: number; // 0-100, reported by OMP (get_state().contextUsage.percent)
}

/** Spec 004 FR-007, FR-017 to FR-020: one row in the Subagents panel and the source the
 * Subagents chip's count is computed from. `id` is the subagent's own `name` from the batch
 * `task()` call's `tasks[]` entry, confirmed stable across every `tool_execution_update`
 * (FINDINGS item 36) -- the same value OMP's own `progress[].id` carries. */
export interface SubagentSummary {
  id: string;
  /** The owning `task()` call's own `toolCallId` (spec 004 remediation, HIGH): a turn with 2+
   * parallel `task` calls, or a repeated subagent name across two calls in the same turn, both
   * need this to correlate a `tool_execution_update`/`tool_execution_end` frame to the right
   * batch -- `id` alone (name or position) is not unique enough across calls. */
  toolCallId: string;
  /** This subagent's position within the owning `task()` call's own `tasks[]` array (spec 004
   * remediation, HIGH, issue #489 gate finding 1): the ONE value both this summary and the chat
   * transcript's own `kind: 'subagent'` row (`subagent:<toolCallId>:<specIndex>`, transcript.ts)
   * derive from the SAME source array in the SAME order -- their respective `id` strings use
   * unrelated schemes and must never be compared directly, so `reconcileSubagentsOnAttach`
   * correlates the two representations of one subagent instance by `toolCallId`+`specIndex`
   * instead. */
  specIndex: number;
  nameOrTask: string;
  /** `'exited'` (issue #489, FINDINGS item 45): Refract still remembered this subagent as
   * `running` from a previous process life by the time the next attach/resume runs. A freshly
   * launched `OmpProcess` never reuses a previous one (`SessionAgent.launch` always spawns a new
   * child), so its own `get_subagents` registry is unconditionally empty -- confirmed live even
   * seconds after a hard-killed process's own genuinely-running subagent, same Conversation file
   * (`docs/spike/get-subagents-probe.mjs`, 2026-10-07, omp 18.8.0) -- so every surviving `running`
   * candidate `reconcileSubagentsOnAttach` finds is unconditionally resolved to `exited`, never
   * by asking OMP. Distinct from `failed`: nothing about the subagent's own work is known to
   * have failed, only its process disappeared. */
  status: 'running' | 'finished' | 'failed' | 'exited';
  startedAt: number;
  durationMs?: number; // present once status is finished, failed, or exited; absent when startedAt was never genuinely known (issue #489 gate finding 8)
}

/** Built in the main process from OMP frames; the renderer only renders items. */
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; at: number }
  | { kind: 'assistant-text'; id: string; text: string; streaming: boolean }
  | {
      kind: 'thinking';
      id: string;
      text: string;
      streaming: boolean; // omitted when the text is empty
      /** Wall-clock bounds for "Thought for Ns" (T075); absent when the source (live or history)
       * carries no usable timing, in which case the row shows just "Thought". */
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: 'tool';
      id: string;
      toolCallId: string;
      tool: string;
      target: string;
      status: 'running' | 'done' | 'error';
      /** Absent when built from history (no reliable wall clock to derive it from), matching
       * the `thinking` item's `startedAt`. */
      startedAt?: number;
      durationMs?: number;
      args: unknown;
      output?: string;
      diff?: string;
      /** The raw `tool_execution_end` `result.details` (or history's `toolResult.details`): read
       * generically by a tool-specific renderer (T073's `ask` answer: `selectedOptions`/
       * `customInput`) instead of adding a one-off TranscriptItem field per tool. */
      details?: unknown;
      /** From an `edit` tool's `tool_execution_end` `result.details`; the renderer builds the unified diff (T025). */
      edit?: { path: string; oldText: string; newText: string };
      /** From a `write` tool's args; the renderer diffs it against a cached prior read/edit of the same path (T025). */
      write?: { path: string; content: string };
    }
  | {
      /** One subagent started by a batch `task()` call (T078): a `tasks` array of N starts N of
       * these, never a single `tool` item, so each has its own collapsed line and (later, spec
       * 004) its own transcript panel. `id` stays stable (`subagent:<toolCallId>:<specIndex>`)
       * across the run so re-opening it keeps the same identity. */
      kind: 'subagent';
      id: string;
      toolCallId: string; // the parent `task` call's id
      specIndex: number; // this spec's position in the owning call's own `tasks[]` (issue #489 gate finding 1: the correlation key `reconcileSubagentsOnAttach` uses, since `id`'s scheme never matches `SubagentSummary.id`'s)
      name: string; // the task's own `name`, else its `task` text truncated
      task: string; // the full prompt text (`tasks[i].task`), shown on expansion
      /** `'exited'` (issue #489 gate finding 4): settled by `SessionAgent.reconcileSubagentsOnAttach`
       * alongside the matching `SubagentSummary` so the chat row stops spinning "running" in step
       * with the Subagents panel, instead of only the panel ever reflecting the orphaned state. */
      status: 'running' | 'done' | 'error' | 'exited';
      /** Absent when built from history (no reliable wall clock to derive it from), matching
       * the `thinking` item's `startedAt`. */
      startedAt?: number;
      durationMs?: number;
      /** The authoritative per-subagent result (FINDINGS item 22(e) `details.jobs[].schema.data`,
       * falling back to `.label`), shown as plain text on expansion once known. */
      result?: string;
      /** The batch call's own `details.progress[].id`/the later `details.jobs[].jobId`, used only
       * to correlate this row across the two frames; never rendered. */
      jobId?: string;
    }
  | {
      /** An IRC-style message between a subagent and the main agent, or between subagents
       * (T079, FR-048); never grouped or hidden. */
      kind: 'agent-message';
      id: string;
      from: string;
      to: string;
      text: string;
      at: number;
    }
  | {
      /** An OMP-injected `<advisory>` note (T084, FR-051), parsed out of a `role: 'custom'`
       * message whose `content` embeds one or more `<advisory severity="..." advisor="..."
       * turns_ago="..." guidance="...">note text</advisory>` elements (FINDINGS item 22(f): every
       * such message carries `customType: 'advisor'`; `turns_ago` is the real OMP 18.5.1
       * producer's own attribute name, snake_case, confirmed against real on-disk session data --
       * it becomes this type's camelCase `turnsAgo` field below). An unknown/missing `severity`
       * reads as `'nit'`; a message that looks like one of these but cannot be parsed falls back
       * to a plain `notice` instead (never this kind, and raw tag text is never shown once
       * parsing succeeds). */
      kind: 'advisory';
      id: string;
      severity: 'nit' | 'concern' | 'blocker';
      advisor?: string;
      turnsAgo?: number;
      guidance?: string;
      text: string;
    }
  | { kind: 'request'; id: string; requestId: string; resolved?: 'approved' | 'denied' | 'answered' | 'cancelled' }
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string };

/** Tool names the agent calls for its own bookkeeping (T086, FR-052): a call to one of these
 * never becomes a `tool` TranscriptItem, so it never reaches the chat transcript -- the only
 * exception to the one-row-per-tool-call rule. A hidden call that fails still surfaces as an
 * `notice` (see `src/main/omp/transcript.ts`), not silently; `groupToolItems` must thread that
 * notice through a run of visible tool calls instead of ending it (see
 * `HIDDEN_TOOL_NOTICE_PREFIX` below). The `todo` tool's own state stays available for a later
 * readout (e.g. `get_state().todoPhases`) regardless of this list. */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['todo']);

/** `id` prefix for the `notice` a hidden tool's failure becomes (T086, FR-052): the one `notice`
 * shape `groupToolItems` must not let end a run of the surrounding visible tool's calls. */
export const HIDDEN_TOOL_NOTICE_PREFIX = 'hidden-tool-error:';

/** `id` prefix for a `notice` built from a `command_output`/`notice` frame that arrived before
 * the user had taken any action in this agent process (`SessionAgent.hasUserActed`) -- OMP's own
 * unsolicited startup banner (lists every mounted MCP tool verbatim) uses the exact same frame
 * shapes a user-run slash command's own output does, so this is the only way to tell them apart.
 * `Transcript.tsx`'s empty-transcript check hides only a notice carrying this prefix (and even
 * then only while nothing else real has happened); a `level: 'error'` notice is never hidden
 * regardless of this prefix, since an error is always a real outcome worth showing. */
export const STARTUP_NOTICE_PREFIX = 'startup-notice:';

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

/** Derived from OMP by scanning `Session.sessionDir` for `*.jsonl` files; not stored by Refract. */
export interface ConversationInfo {
  file: string; // absolute path
  id: string; // the UUID suffix of the file name
  createdAt: string; // ISO timestamp prefix of the file name (no file open needed)
  title: string; // `title` field of the first line of the file, may be empty
  preview: string; // first user message, truncated to 120 characters
  isCurrent: boolean; // file === Session.currentConversation
}

/** spec 008 data-model.md: `profileCache.json`'s whole-file shape -- a small, revalidated
 * display cache for GitHub accounts. Refract never stores a GitHub access token (FR-012);
 * only these two display fields per account, both derived from a one-time profile/avatar
 * fetch (research.md decisions 3-5). */
export interface ProfileCache {
  version: 1;
  accounts: Record<string, ProfileCacheEntry>; // keyed by `${host}/${login}`, e.g. "github.com/stuarthopwood"
}

export interface ProfileCacheEntry {
  displayName: string | null; // null falls back to the login everywhere a name would show
  avatarDataUrl: string | null; // validated data:image/png|jpeg;base64,...; null = show initials
  fetchedAt: string; // ISO 8601; the moment this entry was last successfully refreshed
}