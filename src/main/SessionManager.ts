// Owns the registry and settings stores and the live `SessionAgent`s (tasks.md T016). One
// `SessionAgent` per Session that has ever been opened this run; a Session with no agent is
// listed as `stopped` (data-model.md "A Session that has never been opened this run has no
// `SessionRuntime`"). Forwards every agent event to every subscriber (T017's `ipc/register.ts`
// for the renderer, T038's `notifications.ts` for Windows notifications), so `SessionAgent`
// never needs to know about Electron.

import { existsSync } from 'node:fs';
import type { ApprovalMode, PendingRequest, SessionReadout, SubagentSummary } from '../shared/model';
import type { SessionStatusEvent, SessionSummary, SlashCommand, TranscriptOp } from '../shared/ipc';
import { SessionAgent } from './omp/SessionAgent';
import { resolveTermination } from './omp/stoppedOnRequestMarker';
import type { RegistryStore } from './store/registry';
import type { SettingsStore } from './store/settings';

export type ManagerEvent =
  | { type: 'status'; payload: SessionStatusEvent }
  | { type: 'patch'; payload: { sessionId: string; ops: TranscriptOp[] } }
  | { type: 'queue'; payload: { sessionId: string; followUp: string[]; steering: string[] } }
  | { type: 'request'; payload: { sessionId: string; request: PendingRequest } }
  | { type: 'requestResolved'; payload: { sessionId: string; requestId: string } }
  | { type: 'commands'; payload: { sessionId: string; commands: SlashCommand[] } }
  | { type: 'readout'; payload: { sessionId: string; readout: SessionReadout } }
  | { type: 'subagents'; payload: { sessionId: string; subagents: SubagentSummary[] } }
  | { type: 'subagentPatch'; payload: { sessionId: string; subagentId: string; ops: TranscriptOp[] } }
  | { type: 'list-changed' };

/** Issue #510 (quality gate 2026-10-08): caps how many Sessions' Conversation tails `summaries()`
 * reads at once. Small, since a tail read is bounded (256 KiB max) and cheap on its own, but a
 * registry with many stopped Sessions should not open dozens of file handles in one burst. */
const DETECTION_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `limit` concurrent calls in flight, preserving each
 * result's original position regardless of completion order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export class SessionManager {
  private readonly agents = new Map<string, SessionAgent>();
  private readonly listeners: Array<(event: ManagerEvent) => void> = [];

  /** T036 (spec 005 Decision 1/2: generalised from one id to a set so main never needs to know
   * which pane is which): the Sessions currently shown, across every pane; `transcript:patch`,
   * `readout:update`, `subagents:update`, and `subagent:patch` are only forwarded for ids in this
   * set (contracts/ipc.md). Empty when no Session is open (e.g. the readiness/empty view). */
  private visibleSessionIds = new Set<string>();
  /** T037: whether any Refract window currently has OS focus; set by `index.ts` on focus/blur. */
  private windowFocused = true;

  constructor(
    readonly registry: RegistryStore,
    readonly settings: SettingsStore,
    private readonly ompPath?: string,
  ) {}

  /** Emits `session:list-changed` (contracts/ipc.md): created, renamed, archived, deleted, or
   * reordered by activity. The renderer re-fetches `sessions.list()` in response. */
  notifyListChanged(): void {
    this.emit({ type: 'list-changed' });
  }

  /** Subscribes to every `ManagerEvent`. Multiple independent subscribers are supported (IPC
   * forwarding to the renderer, Windows notifications, ...); each gets every event. */
  onEvent(listener: (event: ManagerEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: ManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Returns the Session's `SessionAgent` if one already exists this run, without creating
   * one. Issue #512 gate-fixes Medium finding: `keepWaitingForStart`/`cancelStart` only ever
   * act on an agent that might be mid-start, so building a brand-new (never-started)
   * `SessionAgent` just to perform a no-op on it, as `getOrCreateAgent` would, is pointless. */
  getAgent(sessionId: string): SessionAgent | undefined {
    return this.agents.get(sessionId);
  }

  /** Returns the Session's `SessionAgent`, creating one (not yet started) on first access. */
  getOrCreateAgent(sessionId: string): SessionAgent {
    const existing = this.agents.get(sessionId);
    if (existing) return existing;
    const agent = new SessionAgent({
      sessionId,
      registry: this.registry,
      settings: this.settings,
      ompPath: this.ompPath,
      isVisible: () => this.visibleSessionIds.has(sessionId),
      isWindowFocused: () => this.windowFocused,
    });
    agent.on('status', (payload) => this.emit({ type: 'status', payload }));
    // T036: transcript:patch is only forwarded for a visible Session; a full reset is sent
    // separately, by setVisible(), the moment a Session becomes visible.
    agent.on('patch', (payload) => {
      if (!this.visibleSessionIds.has(payload.sessionId)) return;
      this.emit({ type: 'patch', payload });
    });
    agent.on('queue', (payload) => this.emit({ type: 'queue', payload }));
    agent.on('request', (payload) => this.emit({ type: 'request', payload }));
    agent.on('requestResolved', (payload) => this.emit({ type: 'requestResolved', payload }));
    agent.on('commands', (payload) => this.emit({ type: 'commands', payload }));
    // Spec 004: readout/subagents/subagentPatch follow `patch`'s own visible-Session-only rule
    // (contracts/ipc.md `readout:update`/`subagent:patch`); a background Session's chip row and
    // panel data keep computing in `SessionAgent`, just unsent until it becomes visible, at which
    // point `sessions.open`'s `SessionSnapshot.readout` carries the current value. Spec 005
    // convergence (tasks.md T004): generalised to set-membership alongside `patch` above, so
    // both panes of a split keep receiving their own chip row and Subagents data, not just
    // whichever pane happened to be picked as "the" visible Session.
    agent.on('readout', (payload) => {
      if (!this.visibleSessionIds.has(payload.sessionId)) return;
      this.emit({ type: 'readout', payload });
    });
    agent.on('subagents', (payload) => {
      if (!this.visibleSessionIds.has(payload.sessionId)) return;
      this.emit({ type: 'subagents', payload });
    });
    agent.on('subagentPatch', (payload) => {
      if (!this.visibleSessionIds.has(payload.sessionId)) return;
      this.emit({ type: 'subagentPatch', payload });
    });
    // HIGH finding (issues #84/#85): `syncFromState` writes `lastModel`/`lastThinkingLevel` (and
    // `currentConversation`/...) to the registry on every settle, Conversation switch, and
    // mode-change restart -- not just on start, which `ipc/sessions.ts`'s `open` handler already
    // covers explicitly. Without this, the message box's cached `sessions.list()` row goes stale
    // the moment the model/effort changes mid-session while `SessionDetailsCard` (which re-fetches
    // on every open) shows the new value -- the two surfaces visibly disagree.
    agent.on('registryUpdated', () => this.notifyListChanged());
    this.agents.set(sessionId, agent);
    return agent;
  }

  /** `sessions.setVisible` (T036/T037, spec 005 Decision 2): selects which Sessions' patches are
   * forwarded; `sessionIds` is every session id currently shown in any pane (0, 1, or 2 elements).
   * For each id newly present that was not already visible, flushes a full transcript snapshot
   * and clears its `unread` flag, exactly as the single-id form did. An empty array means no pane
   * is shown (patches are dropped until a Session becomes visible again). */
  setVisible(sessionIds: string[]): void {
    const next = new Set(sessionIds);
    for (const sessionId of next) {
      if (this.visibleSessionIds.has(sessionId)) continue;
      const agent = this.agents.get(sessionId);
      if (!agent) continue;
      agent.clearUnread();
      this.emit({ type: 'patch', payload: { sessionId, ops: [{ op: 'reset', items: agent.runtimeSnapshot.transcript }] } });
    }
    this.visibleSessionIds = next;
  }

  /** T037: updates every live Session's `isWindowFocused` view; called by `index.ts` on the main
   * window's `focus`/`blur`. */
  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused;
  }

  /** `sessions.list()` row view: every registered Session, live or not (contracts/ipc.md). A
   * Session with no agent this run is checked for a missing worktree folder right here (T043),
   * since there is no `SessionRuntime` yet to carry that reason. Issue #510 slice 2 (PLAN.md row
   * A0): async now -- a `stopped` row (live or never-launched-this-run alike) also reads its
   * Conversation's tail for `terminatedUnexpectedly`, skipped entirely for `worktree-missing` (no
   * useful Conversation to read), an archived Session (not shown as an active row needing a
   * Resume affordance; quality gate 2026-10-08), and every live non-`stopped` status. Reads run
   * at most `DETECTION_CONCURRENCY` at a time -- `detectUnexpectedTermination` itself caches by
   * `(file, size, mtimeMs)`, so an unrelated refresh (any OTHER Session's rename, archive, or
   * status change also fires `session:list-changed`) is cheap, but a large registry's first-ever
   * refresh still opens every stopped Session's file at once without this cap. */
  async summaries(): Promise<SessionSummary[]> {
    return mapWithConcurrency(this.registry.snapshot().sessions, DETECTION_CONCURRENCY, async (session) => {
      const runtime = this.agents.get(session.id)?.runtimeSnapshot;
      if (runtime) {
        // Quality-gate fix (cycle 2, 2026-10-08): a requested stop (`stopAgent`, or any other
        // Refract-initiated shutdown) is never read from the tail at all -- see
        // `SessionRuntime.stoppedOnRequest`'s own doc comment. Without this, a tool call still
        // outstanding when the stop fired (stdin-close, then a 10s wait, then `taskkill`) looks
        // identical, from the file alone, to a genuine mid-call crash. Quality-gate fix (cycle 4,
        // 2026-10-08): `runtime.stoppedOnRequest` is THIS life's own in-memory flag; `
        // resolveTermination` also checks the persisted marker alongside it (cycle 5: shared,
        // not copied here) so a Session reattached fresh this run (a new `SessionAgent`,
        // `stoppedOnRequest` defaulting `false` until its own first exit) still honours an
        // EARLIER life's requested stop, as long as the Conversation has not grown since.
        const terminatedUnexpectedly =
          runtime.status === 'stopped' && !session.archivedAt
            ? (await resolveTermination(session, runtime.stoppedOnRequest)).terminatedUnexpectedly
            : undefined;
        return {
          ...session,
          status: runtime.status,
          stopReason: runtime.stopReason,
          terminatedUnexpectedly,
          startProgress: runtime.startProgress,
          unread: runtime.unread,
          launchedMode: runtime.launchedMode,
          pendingMode: runtime.pendingMode,
        };
      }
      const stopReason = existsSync(session.worktreePath) ? 'not-started' : 'worktree-missing';
      // Quality-gate fix (cycle 4, 2026-10-08): no `SessionRuntime` at all means this Session has
      // not been opened since the app (re)started -- exactly the case `Session.
      // stoppedOnRequestConversation`'s own doc comment describes: the marker is the ONLY signal
      // left that a stop here was requested, not a crash.
      const terminatedUnexpectedly =
        stopReason === 'not-started' && !session.archivedAt
          ? (await resolveTermination(session, false)).terminatedUnexpectedly
          : undefined;
      // Never actually launched this run: nothing is "currently in effect" to show as current,
      // so this falls back to the global Settings mode the renderer already uses pre-launch.
      return {
        ...session,
        status: 'stopped',
        stopReason,
        terminatedUnexpectedly,
        unread: false,
        launchedMode: this.settings.get().approvalMode,
        pendingMode: null,
      };
    });
  }

  /** `settings.setApprovalMode` (T031, FR-015): marks every live Session whose `launchedMode`
   * differs; each restarts at its own next settle (`SessionAgent.restart`). */
  applyPendingModeChange(mode: ApprovalMode): void {
    for (const agent of this.agents.values()) {
      agent.setPendingMode(mode);
    }
  }

  /** T039 `memory:warning`'s `liveAgents` count: Sessions with a running process right now. */
  liveAgentCount(): number {
    return [...this.agents.values()].filter((agent) => agent.runtimeSnapshot.status !== 'stopped').length;
  }

  /** Stops every live agent; used on `before-quit` so no `omp` process outlives the app. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => agent.shutdown()));
  }

  /** `sessions.delete` calls this once the Session and its live agent are both shut down and
   * the registry entry is gone, so the deleted id's `SessionAgent` (event listeners and all) is
   * not kept alive forever in `agents` for a Session that can never be reopened. */
  removeAgent(sessionId: string): void {
    this.agents.delete(sessionId);
  }
}
