// Owns the registry and settings stores and the live `SessionAgent`s (tasks.md T016). One
// `SessionAgent` per Session that has ever been opened this run; a Session with no agent is
// listed as `stopped` (data-model.md "A Session that has never been opened this run has no
// `SessionRuntime`"). Forwards every agent event to every subscriber (T017's `ipc/register.ts`
// for the renderer, T038's `notifications.ts` for Windows notifications), so `SessionAgent`
// never needs to know about Electron.

import { existsSync } from 'node:fs';
import type { ApprovalMode, PendingRequest } from '../shared/model';
import type { SessionStatusEvent, SessionSummary, SlashCommand, TranscriptOp } from '../shared/ipc';
import { SessionAgent } from './omp/SessionAgent';
import type { RegistryStore } from './store/registry';
import type { SettingsStore } from './store/settings';

export type ManagerEvent =
  | { type: 'status'; payload: SessionStatusEvent }
  | { type: 'patch'; payload: { sessionId: string; ops: TranscriptOp[] } }
  | { type: 'queue'; payload: { sessionId: string; followUp: string[]; steering: string[] } }
  | { type: 'request'; payload: { sessionId: string; request: PendingRequest } }
  | { type: 'requestResolved'; payload: { sessionId: string; requestId: string } }
  | { type: 'commands'; payload: { sessionId: string; commands: SlashCommand[] } }
  | { type: 'list-changed' };

export class SessionManager {
  private readonly agents = new Map<string, SessionAgent>();
  private readonly listeners: Array<(event: ManagerEvent) => void> = [];

  /** T036: the Session currently shown in the renderer; `transcript:patch` is only forwarded for
   * this one (contracts/ipc.md). `null` when no Session is open (e.g. the readiness/empty view). */
  private visibleSessionId: string | null = null;
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

  /** Returns the Session's `SessionAgent`, creating one (not yet started) on first access. */
  getOrCreateAgent(sessionId: string): SessionAgent {
    const existing = this.agents.get(sessionId);
    if (existing) return existing;
    const agent = new SessionAgent({
      sessionId,
      registry: this.registry,
      settings: this.settings,
      ompPath: this.ompPath,
      isVisible: () => this.visibleSessionId === sessionId,
      isWindowFocused: () => this.windowFocused,
    });
    agent.on('status', (payload) => this.emit({ type: 'status', payload }));
    // T036: transcript:patch is only forwarded for the visible Session; a full reset is sent
    // separately, by setVisible(), the moment a Session becomes visible.
    agent.on('patch', (payload) => {
      if (payload.sessionId !== this.visibleSessionId) return;
      this.emit({ type: 'patch', payload });
    });
    agent.on('queue', (payload) => this.emit({ type: 'queue', payload }));
    agent.on('request', (payload) => this.emit({ type: 'request', payload }));
    agent.on('requestResolved', (payload) => this.emit({ type: 'requestResolved', payload }));
    agent.on('commands', (payload) => this.emit({ type: 'commands', payload }));
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

  /** `sessions.setVisible` (T036/T037): selects which Session's patches are forwarded, flushes a
   * full transcript snapshot for it, and clears its `unread` flag. `null` means no Session is
   * currently shown (patches are dropped until another Session becomes visible). */
  setVisible(sessionId: string | null): void {
    this.visibleSessionId = sessionId;
    if (sessionId === null) return;
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    agent.clearUnread();
    this.emit({ type: 'patch', payload: { sessionId, ops: [{ op: 'reset', items: agent.runtimeSnapshot.transcript }] } });
  }

  /** T037: updates every live Session's `isWindowFocused` view; called by `index.ts` on the main
   * window's `focus`/`blur`. */
  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused;
  }

  /** `sessions.list()` row view: every registered Session, live or not (contracts/ipc.md). A
   * Session with no agent this run is checked for a missing worktree folder right here (T043),
   * since there is no `SessionRuntime` yet to carry that reason. */
  summaries(): SessionSummary[] {
    return this.registry.snapshot().sessions.map((session) => {
      const runtime = this.agents.get(session.id)?.runtimeSnapshot;
      if (runtime) {
        return {
          ...session,
          status: runtime.status,
          stopReason: runtime.stopReason,
          unread: runtime.unread,
          launchedMode: runtime.launchedMode,
          pendingMode: runtime.pendingMode,
        };
      }
      const stopReason = existsSync(session.worktreePath) ? 'not-started' : 'worktree-missing';
      // Never actually launched this run: nothing is "currently in effect" to show as current,
      // so this falls back to the global Settings mode the renderer already uses pre-launch.
      return { ...session, status: 'stopped', stopReason, unread: false, launchedMode: this.settings.get().approvalMode, pendingMode: null };
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
