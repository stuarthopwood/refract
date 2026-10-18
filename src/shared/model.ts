// Data stored or held by Refract, and the shapes Refract derives from OMP.
// Field names and literal unions follow specs/001-core-session-workspace/data-model.md exactly.

import type { ThemeId } from './themes';
import type { ChatWidth } from './chatWidth';
import type { TranscriptDisplaySettings } from './transcriptDisplay';

/** A local git project the developer has added to Refract. Owns zero or more Sessions. */
export interface Repository {
  id: string; // uuid
  path: string; // absolute path of the main checkout
  // Issue #480: display name, shown as the list group title. Set to `path.basename(path)` when
  // the repository is added; renamable afterward (`repositories.rename`), same rule as the
  // Session rename (FR-004): never touches the folder, worktrees, or branch names. An empty
  // (after trimming) rename resets it back to the folder's own basename.
  name: string;
  defaultBranch: string; // read from git when added; preselected as Base branch
  addedAt: string; // ISO 8601
  // Issue #528: whether this repository has a configured git remote, for the session list's
  // group-header icon and its tooltip. `repositories.list()` returns the `unknown` placeholder
  // immediately for every entry (gate round 3 fix: computing it inline used to delay the whole
  // workspace's first paint); the real value is computed fresh in main
  // (`src/main/git/remote.ts`) by the separate `repositories.remotes()` call, and inline in
  // `add()`/`rename()`'s own responses. NEVER read from or written to `registry.json` -- a
  // repository's own remote can change on disk at any time (added, changed, removed) with no
  // Refract action involved, so persisting a stale value would be actively misleading. Optional
  // only because it is absent until that first computation (for example inside a unit test's
  // hand-built `Repository`, which never goes through the IPC boundary this field is attached
  // at).
  remote?: RepositoryRemote;
}

/** Issue #528: the two real states this icon/tooltip needs (`none`/`has`), plus an honest "could
 * not tell" case -- `unknown` means detection could not confirm either way (an unreadable
 * repository, a timed-out or aborted check, or a remote URL this reader could not parse a host
 * from), never conflated with a confirmed `none`. Deliberately binary beyond that (`has`/`none`),
 * not split further by host: the originally decided three-way host classification
 * (`known`/`other`) plus `@tabler/icons-react` brand marks was deferred, not reversed, by Main
 * (delegated by Stuart), who asked for the simpler remote-vs-local-only distinction with no new
 * dependency this round -- tracked as follow-up issue #646. */
export type RepositoryRemote = { kind: 'none' } | { kind: 'has'; host: string } | { kind: 'unknown' };

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
  /** Issue #489 (PLAN.md row A2c, durable turn marker, 2026-10-07): the current turn's subagent
   * instances, as `${toolCallId}:${specIndex}` keys -- the SAME correlation key
   * `SessionAgent.reconcileSubagentsOnAttach` and `transcript.ts`'s `settleStaleSubagentRows` use
   * to match a `SubagentSummary` to its chat-transcript `kind: 'subagent'` row. Written by
   * `SessionAgent.handleTaskStart` as soon as a `task` call starts (queued at once and landing
   * atomically within milliseconds; it can be lost only if the Electron main process itself dies
   * in that window, or the write fails and is logged), cleared at the next `agent_start` -- the
   * SAME boundary that clears the
   * in-memory `runtime.subagents` array, never by a steer or a consumed `followUp` inside the
   * same OMP run (steering never fires `agent_start`; a consumed `followUp` can only ever be
   * promoted after the prior turn, including its subagents, already fully settled). Replaces the
   * previous transcript-position ("last `kind: 'user'` item") heuristic, which could not tell a
   * steer mid-subagent apart from a genuinely new turn without reintroducing an EARLIER turn's
   * finished subagents resurfacing as "current". Absent (old registries, or no subagents this
   * turn) means empty scope -- no migration needed. */
  currentTurnSubagents?: string[];
  /** Issue #510 quality-gate fix (cycle 4, 2026-10-08): the persisted sibling of in-memory
   * `SessionRuntime.stoppedOnRequest`, surviving an app restart. Written by `SessionAgent.onExit`'s
   * requested-stop branch (`stoppedOnRequestMarker.ts`'s `recordStoppedOnRequestMarker`): the
   * Session's `currentConversation` path at that moment, and that file's exact byte size then.
   * Cleared at the top of every `launch()` attempt (`clearStoppedOnRequestMarker`) -- a new life
   * starting means whatever the PREVIOUS life's requested stop protected no longer applies.
   * Honoured by `summaries()`/`buildSnapshot`/`attachSnapshot` (`isStoppedOnRequestMarkerValid`)
   * ONLY while `stoppedOnRequestConversation` still equals the Session's current Conversation AND
   * `stoppedOnRequestAtSize` still equals that file's real current size -- any growth means a
   * later life ran and appended to it, so the tail is judged fresh, exactly as if no marker
   * existed. Both absent/null: no marker was ever set, or a later life already cleared it. */
  stoppedOnRequestConversation?: string | null;
  stoppedOnRequestAtSize?: number | null;
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
  chatWidth: ChatWidth; // issue #554, FR-049/FR-073: default 'full'
  transcriptDisplay: TranscriptDisplaySettings; // issue #457: default both true
  showSampleData: boolean; // spec 013 FR-020 to FR-022: default false
  detectImagePathsOnPaste: boolean; // #514: turn off path-based image-attach detection entirely; default true, immediate-apply, no migration.
  wordPredictionEnabled?: boolean; // Issue #772 (Rust-only, epic #797): off switch, default false on Rust (see FINDINGS item 28); absent means enabled -- no Electron implementation.
  sessionListCollapse: SessionListCollapse; // #735: per-Repository/Archived collapse state; `session-list-store.ts` is the sole writer.
}
export interface SessionListCollapse { collapsedRepositoryIds: string[]; archivedOpen: boolean; } // #735 data-model.md: diff-from-default only (absent id = open, archivedOpen default false); #638 reordering can't disturb an id-keyed collapse.
export const DEFAULT_SESSION_LIST_COLLAPSE: Readonly<SessionListCollapse> = Object.freeze({ collapsedRepositoryIds: [], archivedOpen: false });
export { type TranscriptDisplaySettings, DEFAULT_TRANSCRIPT_DISPLAY } from './transcriptDisplay';

/** OMP model-role ids (issue #455, `omp://models.md` "Role aliases and settings"): built-in chat
 * roles plus model-kind roles. A role's VALUE is a plain model selector OMP itself resolves
 * (`provider/modelId[:thinking]`, an `@role` alias, or a comma-separated list) -- Refract
 * validates only length and control/formatting characters (`assertValidSelector`,
 * `src/main/omp/config.ts`), never that the selector resolves to a real model: live-probed
 * (`docs/spike/model-roles-probe.mjs`, FINDINGS item 48) that `omp config set modelRoles`
 * itself accepts any string value with no model-resolution validation at set time -- the
 * renderer's catalog-only picker (never free text) is the real safeguard, not the CLI. */
export type ModelRoleId =
  | 'default'
  | 'smol'
  | 'slow'
  | 'vision'
  | 'plan'
  | 'commit'
  | 'tiny'
  | 'memory'
  | 'task'
  | 'advisor'
  | 'image'
  | 'web'
  | 'speech'
  | 'dictation'
  | 'judge';

/** Chat roles (`omp://models.md`): accept ordinary chat models (`tiny`/`memory` also accept
 * `tiny`-catalog models, grouped under the same `chat` catalog kind here for a first picker cut). */
export const CHAT_MODEL_ROLES: readonly ModelRoleId[] = ['default', 'smol', 'slow', 'vision', 'plan', 'commit', 'tiny', 'memory', 'task', 'advisor'];

/** Model-kind roles (`omp://models.md`): each selects a different catalog kind's runner. */
export const MODEL_KIND_ROLES: readonly ModelRoleId[] = ['image', 'web', 'speech', 'dictation', 'judge'];

/** `omp models --kind <kind>` catalog groupings (`omp://models.md` "Catalog kinds are `chat`,
 * `tiny`, `image`, `tts`, `stt`, `search`, and `judge`"). */
export type CatalogKind = 'chat' | 'tiny' | 'image' | 'tts' | 'stt' | 'search' | 'judge';

const CATALOG_KINDS: Record<string, true> = { chat: true, tiny: true, image: true, tts: true, stt: true, search: true, judge: true };

/** Defensive-validate-before-cast lookup (matching `ipc/settings.ts`'s existing `APPROVAL_MODES`/
 * `READOUT_KINDS` `Record<K, true>` pattern), shared by `main/omp/config.ts` and
 * `main/ipc/modelRoles.ts` so the seven-entry catalog-kind vocabulary is declared in exactly one
 * place (quality-gate remediation, code-reviewer LOW: these two used to keep their own
 * hand-copied `CATALOG_KINDS` literal). */
export function isCatalogKind(value: unknown): value is CatalogKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATALOG_KINDS, value);
}

/** Which catalog kind each role's model picker queries (`omp://models.md` "Role aliases and
 * settings": `web` selects search/grounded-chat runners, `speech` selects TTS, `dictation`
 * selects STT, `judge` selects judgment runners; `image` selects image runners). `tiny` and
 * `memory` deliberately query `chat` rather than the `tiny` catalog kind (quality-gate
 * remediation, code-reviewer LOW: `tiny` has no role mapped to it, so tiny-only catalog models
 * are never offered in their pickers) -- their documented fallback chain (`tiny` -> `smol`,
 * `memory` -> `tiny` -> `smol`) bottoms out at ordinary chat models, so the chat catalog is what
 * their picker should actually offer. */
export const ROLE_CATALOG_KIND: Record<ModelRoleId, CatalogKind> = {
  default: 'chat',
  smol: 'chat',
  slow: 'chat',
  vision: 'chat',
  plan: 'chat',
  commit: 'chat',
  tiny: 'chat',
  memory: 'chat',
  task: 'chat',
  advisor: 'chat',
  image: 'image',
  web: 'search',
  speech: 'tts',
  dictation: 'stt',
  judge: 'judge',
};

/** Type guard preserving narrowing at the IPC boundary (`ipc/modelRoles.ts`, preload, renderer
 * store) -- this is the one allowed "tiny function" case: it is a type guard, not a rename.
 * Reuses `ROLE_CATALOG_KIND` (already a `Record<ModelRoleId, CatalogKind>` covering every role)
 * instead of keeping a second, hand-copied `Record<string, true>` in sync by hand (quality-gate
 * remediation, code-reviewer LOW: a role added to the `ModelRoleId` union but not to that second
 * literal would have been silently rejected at the IPC boundary with no compile error). */
export function isModelRoleId(value: unknown): value is ModelRoleId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_CATALOG_KIND, value);
}

/** One `omp models --kind <kind> --json` row (fields this feature needs; the CLI returns more --
 * `omp://models.md` "JSON includes provider, kind, id, selector, name, ..."). `selector` is the
 * exact `provider/modelId` string usable as a `modelRoles` value. */
export interface ModelCatalogEntry {
  provider: string;
  id: string;
  selector: string;
  name: string;
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

/** Issue #510 slice 2 (PLAN.md row A0), fed to #509's Resume button: as direct as the word
 * Stuart actually typed resuming his own crashed session ("resume"). No goal-mode variant yet --
 * goal mode (#479) does not exist in this codebase; a `goal resume` default is #479's own job
 * once that field exists on `Session`. */
export const DEFAULT_RESUME_INSTRUCTION = 'resume';

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

/** Issue #512 requirement 1: the staged ready-wait's default ceiling (fails outright if the
 * `ready` frame has not arrived by then) -- shared between `OmpProcess.ts` (the real default,
 * overridable per instance via `OmpProcessOptions.readyCeilingMs`) and `ChatPane.tsx` (the
 * announcement-only "about N more minutes" estimate for "Keep waiting"). Gate-fixes Low finding
 * (cycle 6): these used to be two separately-hand-kept constants with the same value; a change
 * to one without the other would have silently drifted the announcement from the real ceiling.
 */
export const READY_CEILING_MS = 180_000;

/** Issue #512 requirement 1: the staged ready-wait's live progress while a Session is starting,
 * mirroring `OmpProcess`'s own `'start-progress'`/`'start-queued'`/`'start-memory-deferred'`
 * events one-for-one. Absent once `start()` settles (success or failure) either way -- this is
 * never a persisted Session state, only a transient overlay on top of `status`/`stopReason`. */
export type SessionStartProgress =
  | { kind: 'queued' }
  | { kind: 'memory-deferred'; elapsedMs: number }
  | { kind: 'waiting' | 'prompt' | 'extended'; elapsedMs: number };

/** Held in memory: one per Session with a live or recently live agent. */
export interface SessionRuntime {
  sessionId: string;
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  stopDetail?: string; // exit code, missing path, or setup message
  /** Issue #512: set while a `start()`/`restart()` is in flight, cleared the instant it settles. */
  startProgress?: SessionStartProgress;
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null; // set while a mode change waits for idle
  unread: boolean;
  transcript: TranscriptItem[]; // current Conversation, normalised
  queue: { followUp: string[]; steering: string[] }; // mirrors OMP queue_update
  pending: PendingRequest[]; // approvals and questions waiting for the user
  turnStartedAt: number | null; // spec 004: epoch ms; set on agent_start, cleared on session_settled/stop
  readout: SessionReadout; // spec 004: last assembled bundle; never persisted
  subagents: SubagentSummary[]; // spec 004: current turn's subagents; cleared when a new turn starts
  /** Quality-gate fix (cycle 2, 2026-10-08): true from the moment a REQUESTED stop (`stopAgent`,
   * or any other Refract-initiated shutdown) actually exits the process, cleared the instant a
   * new process life starts (`launch()`). A requested stop is never "terminated unexpectedly" by
   * definition, regardless of what the Conversation's tail happens to show -- a tool call still
   * outstanding when the stdin-close-then-`taskkill` sequence fires looks identical, from the
   * file alone, to a genuine mid-call crash. Every reader that would otherwise re-derive
   * `terminatedUnexpectedly` from the tail (`SessionManager.summaries()`, `ipc/util.ts`'s
   * `buildSnapshot`) must check this first and skip the tail read entirely when it is set. */
  stoppedOnRequest: boolean;
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
  // Gate fixes 2 finding 7: `finished`/`exited`/`failed` are separate counts, not folded
  // together -- the chip's own wording must be able to distinguish "1 finished, 1 exited" from
  // a plain "2 finished", and a turn whose only subagents failed must never read a misleading
  // "0 finished" (SubagentsChip, ReadoutChips.tsx); `cancelled` (issue #563) is its own count too.
  subagentCount: { running: number; finished: number; exited: number; failed: number; cancelled: number } | null; // null = turn has started none (chip hidden)
  todoProgress: { done: number; total: number } | null; branch?: { name: string; detached: boolean } | null; // todoProgress: null = no task list; branch (#724/R5): live branch or (detached) sha
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
   * have failed, only its process disappeared.
   *
   * Gate fixes 2 finding 9: that probe exercised two `omp` processes within one Node script, never
   * an actual Refract app crash -- across a REAL crash/restart an orphaned `omp.exe` genuinely
   * CAN outlive it on Windows for a window, so "its process disappeared" is not simply assumed:
   * `src/main/process/jobObject.ts`'s Job Object kills every descendant the instant Refract's own
   * process dies (primary defence), and `src/main/process/pidRecords.ts`'s `reapStale()` is the
   * fallback for the rarer case Refract itself was killed too abruptly even for that -- run from
   * `src/main/index.ts` at startup, awaited before any Session/`SessionAgent` ever attaches, so by
   * the time `reconcileSubagentsOnAttach` runs the previous life's process is confirmed gone for
   * real, not merely assumed. */
  status: 'running' | 'finished' | 'failed' | 'cancelled' | 'exited';
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
      /** `'interrupted'` (issue #510 slice 3, PLAN.md row A0): a call built from history that
       * never received a result, in a Conversation whose tail `detectUnexpectedTermination`
       * (terminationDetection.ts) confirms the writing process is actually gone -- same family as
       * `'exited'` on a `subagent` item below (#489), just file-tail-derived instead of
       * registry-derived, and never asserted for a Session that is genuinely still `working`
       * right now (see `transcript.ts`'s `settleInterruptedToolRows`). No permanent spinners. */
      status: 'running' | 'done' | 'error' | 'interrupted';
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
      /** Set when this `read` call's target is a `skill://` URL (issue #543, first slice):
       * `name` is the URL's remainder after `skill://`. A grouping boundary -- `groupToolItems`
       * never folds this call into a run of adjacent `read` calls -- and the row's label reads
       * "Using skill: <name>" instead of the raw tool name; expansion is unchanged (the same
       * arguments/result view any other `read` row gets). */
      skill?: { name: string };
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
      status: 'running' | 'done' | 'error' | 'cancelled' | 'exited';
      startedAt?: number; // absent when built from history (no reliable wall clock to derive it from), matching the `thinking` item's `startedAt`
      durationMs?: number;
      /** The authoritative per-subagent result (FINDINGS item 22(e) `details.jobs[].schema.data`,
       * falling back to `.label`), shown as plain text on expansion once known. */
      result?: string;
      /** The batch call's own `details.progress[].id`/the later `details.jobs[].jobId`, used only
       * to correlate this row across the two frames; never rendered. */
      jobId?: string;
      messageId: string; // owning assistant message's id (history `h{index}`, live real id); `groupSubagentStages` keys Stage membership on this, not timing (#563 gate round 2 addendum A)
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
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string }
  | {
      /** A user-invoked `/skill:<name>` custom message (issue #547): OMP's `role: 'custom'`
       * `customType: 'skill-prompt'` message, `attribution: 'user'`, `display: true`. Rendered as
       * its own row reading "Skill invoked: <name>", with `args`/`lineCount` summarised and
       * `text` (the full injected skill body) collapsed behind an explicit expand, rendered as
       * sanitised Markdown (constitution V: it is skill prose, not trusted markup). A message
       * that matches the type but whose `details` carries no usable `name` falls back to the
       * generic `notice` kind above instead of this one (FR-063). */
      kind: 'skill-prompt';
      id: string;
      name: string;
      args?: string;
      lineCount?: number;
      text: string;
    };

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

/** One question of an `ask`-tool batch (`omp://rpc.md` "Extension UI Sub-Protocol"); `preview`
 * is rich-dialog-only and never sent, so it is not represented here. */
export interface AskQuestion { id: string; question: string; header?: string; options: { label: string; description?: string }[]; multi: boolean; recommended?: number; }

/** `requestId` is the `id` of the OMP `extension_ui_request`. Does not survive a process restart.
 * `kind: 'ask'` is the structured dialog (#572), built once `set_ask_dialog` is confirmed
 * enabled for this process; `deadlineAt` is epoch ms from the frame's own `timeout` milliseconds
 * (OMP's wire value is already ms, not seconds -- `rpc.md`'s own example shows `"timeout": 30000`). */
export type PendingRequest =
  | { kind: 'approval'; requestId: string; tool: string; target: string; details: string[] }
  | { kind: 'question'; requestId: string; title: string; message?: string; options: string[]; optionDetails?: (string | undefined)[]; inputKind: 'choice' | 'text' | 'confirm' }
  | { kind: 'ask'; requestId: string; questions: AskQuestion[]; deadlineAt?: number };

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

/** Spec 015 data-model.md: one row of the File explorer's tree (FR-004 to FR-007). Relative to
 * the Session's own worktree root (never absolute, never escaping it -- `resolveInWorktree`,
 * `src/main/ipc/files.ts`, enforces this main-side before any read). `.git` itself is never
 * represented as a node (FR-007, checked on the path as typed AND on its realpath'd result, so
 * neither a literal `.git`/`.GIT` segment nor the Windows 8.3 alias `GIT~1` can resolve to it).
 * `kind: 'folder'`/`'file'` reflects the FOLLOWED type for a symlink/junction entry (so a
 * symlinked folder still renders with a disclosure control) -- but ONLY once `resolveInWorktree`
 * has independently proven EVERY hop of the link's target realpaths inside the worktree first.
 * PR #671 gate round 1 fix (security-auditor HIGH) stopped a listing from `fs.stat`/`fs.realpath`-
 * ing a link's RAW target before any check at all; round 2 (security-auditor/code-reviewer/
 * verification/a11y HIGH, reproduced live) found that fix still vetted only the entry's own
 * FIRST hop -- a chain (`a` -> in-root `b`, `b` -> a UNC share) or a link sitting in a MIDDLE
 * path segment still reached `fs.realpath` unchecked on the SECOND hop, opening a zero-click
 * outbound SMB/NTLM connection. `resolveInWorktree` now walks every hop itself, one path segment
 * at a time, re-vetting any substituted link's own target before going on (`resolveNoFollow`,
 * files.ts) -- no remaining call in this codebase resolves a chain of links in one native call.
 * A link whose target escapes the worktree, is a UNC/device path, or is simply broken -- at ANY
 * hop of however long a chain -- resolves to `kind: 'cannot-access'` instead -- the row this
 * spec.md's own Edge Cases section calls a "cannot access" state. `gitStatus` arrives in Slice 2
 * (data-model.md `GitStatusMark`); absent in Slice 1. */
export type FileTreeEntryKind = 'file' | 'folder' | 'cannot-access';

export interface FileTreeNode {
  /** Relative to the worktree root, POSIX-style `/` separators regardless of platform (FR-004). */
  path: string;
  /** Last path segment; the row's own label. */
  name: string;
  kind: FileTreeEntryKind;
  /** Spec 015 Slice 2 (FR-010, FR-011, data-model.md `GitStatusMap`): the shared git-status/
   * ignore reader's own mark for this path, merged in by the renderer from `fileExplorer.
   * getStatus`'s own full-worktree map, not sent by `listDirectory` itself. `undefined` means
   * clean/untracked-and-not-shown, never "unknown". `.git` itself is never a key in that map
   * (FR-007), so this is never set for the (nonexistent) `.git` node either. */
  gitStatus?: GitStatusMark;
}

/** Spec 015 Slice 2 (data-model.md `GitStatusMap`): one path's current mark against `git status`
 * right now (not a merge-base diff like `DiffStat`). Extended once (lane R7, issues #790/#768)
 * with `renamed`/`conflicted`/`staged`, kept distinct from the start rather than collapsed. */
export type GitStatusMark = 'modified' | 'added' | 'untracked' | 'deleted' | 'ignored' | 'renamed' | 'conflicted' | 'staged';

/** Spec 015 Slice 2 (data-model.md `GitStatusMap`): keyed by path, relative to the worktree
 * root, matching `FileTreeNode.path`'s own convention. A path absent from this map is clean and
 * not ignored; `.git` itself is never a key (FR-007). Built for reuse, as-is, by the future
 * git-changes panel (#464, FR-011), not gated on that panel's own existence. */
export type GitStatusMap = Record<string, GitStatusMark>;

/** Spec 015 Slice 2 (data-model.md `FilePreview`, FR-012 to FR-015): the currently-selected
 * file's preview data. Replaced wholesale on every selection change; `kind: 'deleted'` when the
 * underlying file disappears while open (FR-021), never left showing stale content. `kind:
 * 'read-error'` (PR #671 gate round 4 fix, Medium): a non-`ENOENT` failure reading an otherwise-
 * present file (`EACCES`/`EBUSY`, e.g. an agent has it open for writing) is a DIFFERENT state
 * from "it no longer exists" -- the earlier version mapped every read failure to `'deleted'`,
 * which reads as "removed or renamed" even when the file is still sitting right there. */
export type FilePreviewKind = 'text' | 'markdown' | 'image' | 'binary' | 'too-large' | 'deleted' | 'read-error';

export interface FilePreview {
  path: string;
  kind: FilePreviewKind;
  /** Bytes on disk at read time; present for every kind except `'deleted'`/`'read-error'` --
   * shown alongside the "cannot preview" state for `'binary'`/`'too-large'` (FR-015, SC-001). */
  size?: number;
  /** `kind: 'text'` (FR-012, the shared `CodeBlock`/Shiki) or `kind: 'markdown'` (FR-013, the
   * shared `Markdown` component by default, with a Source toggle that re-renders this same
   * string through `CodeBlock` instead). Absent for every other kind. */
  content?: string;
  /** `kind: 'image'` only (FR-014): base64 bytes, wrapped renderer-side into
   * `data:${mimeType};base64,${base64}` -- the identical convention `attachments.ts`/
   * `AttachmentStrip.tsx` already use for a pasted image's own `previewUrl` (research.md
   * decision 4). Detected by magic bytes, never by file extension. */
  base64?: string;
  mimeType?: string;
}
