// Per-Session controller (tasks.md T016, T024, T027, T028): owns one Session's `OmpProcess`, its
// in-memory `SessionRuntime` (data-model.md "Held in memory"), and the status transitions in
// data-model.md "State transitions". Frames flow through `transcript.ts` (`fromHistory`/
// `applyFrame`); dialogs (`extension_ui_request`) are classified by `dialogs.ts` and answered via
// `answerRequest` (T028).
//
// Designed for later, additive extension (per tasks.md): T040 adds an explicit stop-agent path
// (`shutdown()` already covers the process-kill half of that); T045 adds `recover()`. Neither
// needs to change the shape below, only add methods and extra cases to `onFrame`.

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OmpProcess } from './OmpProcess';
import { applyFrame, fromHistory } from './transcript';
import { classifyDialog, buildDialogResponse } from './dialogs';
import type {
  AvailableCommandsUpdateFrame,
  ExtensionUiRequestFrame,
  Frame,
  GetMessagesResponseData,
  GetStateResponseData,
  QueueUpdateFrame,
  SwitchSessionResponseData,
} from '../../shared/frames';
import type { ApprovalMode, PendingRequest, Session, SessionRuntime, SessionStatus, TranscriptItem } from '../../shared/model';
import type { ChatAnswer, SessionStatusEvent, SlashCommand, TranscriptOp } from '../../shared/ipc';
import type { RegistryStore } from '../store/registry';
import type { SettingsStore } from '../store/settings';

/** At most one `patch` event per Session in this window (contracts/ipc.md `transcript:patch`). */
const PATCH_COALESCE_MS = 50;
const ABORT_SETTLE_TIMEOUT_MS = 60_000;

/** `chat.send`/`chat.stop` etc. map to these when the underlying condition fails, so the IPC
 * layer can translate them to the matching `IpcErrorCode` (`not-idle` / `reattach-failed`). */
export class SessionNotIdleError extends Error {
  readonly code = 'not-idle' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotIdleError';
  }
}

export class ReattachFailedError extends Error {
  readonly code = 'reattach-failed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ReattachFailedError';
  }
}

export interface SessionAgentEvents {
  status: (payload: SessionStatusEvent) => void;
  patch: (payload: { sessionId: string; ops: TranscriptOp[] }) => void;
  queue: (payload: { sessionId: string; followUp: string[]; steering: string[] }) => void;
  request: (payload: { sessionId: string; request: PendingRequest }) => void;
  requestResolved: (payload: { sessionId: string; requestId: string }) => void;
  commands: (payload: { sessionId: string; commands: SlashCommand[] }) => void;
}

// EventEmitter's own typings are untyped by default; this declaration merge narrows `on`/`emit`
// to SessionAgentEvents so the IPC layer (SessionManager) gets typed payloads without a cast.
export declare interface SessionAgent {
  on<K extends keyof SessionAgentEvents>(event: K, listener: SessionAgentEvents[K]): this;
  emit<K extends keyof SessionAgentEvents>(event: K, ...args: Parameters<SessionAgentEvents[K]>): boolean;
}

export interface SessionAgentOptions {
  sessionId: string;
  registry: RegistryStore;
  settings: SettingsStore;
  /** Overrides the `omp` binary resolved from PATH; forwarded to `OmpProcess`. */
  ompPath?: string;
  /** T037: whether this Session is the one currently shown in the renderer; owned by
   * `SessionManager`, which knows the visible-session selection. */
  isVisible: () => boolean;
  /** T037: whether any Pinion window currently has OS focus; owned by `SessionManager`. */
  isWindowFocused: () => boolean;
}

export class SessionAgent extends EventEmitter {
  readonly sessionId: string;

  private readonly registry: RegistryStore;
  private readonly settings: SettingsStore;
  private readonly ompPath: string | undefined;
  private readonly isVisible: () => boolean;
  private readonly isWindowFocused: () => boolean;

  private process: OmpProcess | undefined;
  private runtime: SessionRuntime;
  private commands: SlashCommand[] = [];

  private pendingOps: TranscriptOp[] = [];
  private patchTimer: NodeJS.Timeout | undefined;
  /** True only while `restart()` is tearing down and respawning the process, so `onExit`'s
   * normal agent-exited handling (status flip, notice) is skipped in favour of `restart()`'s own,
   * quieter transition (FR-020: a mode-change restart must not look like a crash). */
  private restarting = false;

  constructor(opts: SessionAgentOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.registry = opts.registry;
    this.settings = opts.settings;
    this.ompPath = opts.ompPath;
    this.isVisible = opts.isVisible;
    this.isWindowFocused = opts.isWindowFocused;
    this.runtime = {
      sessionId: opts.sessionId,
      status: 'stopped',
      stopReason: 'not-started',
      launchedMode: this.settings.get().approvalMode,
      pendingMode: null,
      unread: false,
      transcript: [],
      queue: { followUp: [], steering: [] },
      pending: [],
    };
  }

  /** A read-only snapshot of the in-memory runtime (data-model.md `SessionRuntime`). */
  get runtimeSnapshot(): Readonly<SessionRuntime> {
    return this.runtime;
  }

  /** The latest `available_commands_update` list (`chat.commands`, the slash-command menu). */
  get availableCommands(): readonly SlashCommand[] {
    return this.commands;
  }

  private requireSession(): Session {
    const session = this.registry.getSession(this.sessionId);
    if (!session) {
      throw new Error(`SessionAgent ${this.sessionId}: session not found in registry`);
    }
    return session;
  }

  /**
   * Spawns the agent for this Session's worktree and brings it to `idle`. Resolves once the
   * Session is ready for a prompt; rejects (after moving the runtime to `stopped`) on any
   * failure: a missing worktree, a spawn/handshake failure, or a failed reattach verification.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error(`SessionAgent ${this.sessionId}: already started`);
    }
    const session = this.requireSession();

    if (!(await fs.stat(session.worktreePath).then(() => true, () => false))) {
      this.setStatus('stopped', { stopReason: 'worktree-missing', stopDetail: session.worktreePath });
      throw new Error(`Worktree missing: ${session.worktreePath}`);
    }

    const approvalMode = this.settings.get().approvalMode;
    const proc = new OmpProcess({
      cwd: session.worktreePath,
      approvalMode,
      resumeFile: session.currentConversation ?? undefined,
      sessionId: session.id,
      ompPath: this.ompPath,
    });
    proc.on('frame', (frame: Frame) => this.onFrame(frame));
    proc.on('exit', (info: { code: number | null; requested: boolean }) => this.onExit(info));

    try {
      await proc.start();
    } catch (err) {
      this.recordStartFailure(err instanceof Error ? err.message : String(err));
      throw err;
    }
    this.process = proc;

    let state: GetStateResponseData;
    try {
      const stateRes = await proc.request({ type: 'get_state', id: '' });
      if (!stateRes.success) {
        throw new Error(`get_state failed: ${stateRes.error ?? 'unknown error'}`);
      }
      state = stateRes.data as GetStateResponseData;
    } catch (err) {
      await proc.stop();
      this.process = undefined;
      this.recordStartFailure(err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (session.currentConversation) {
      const failure = this.verifyReattach(session, state);
      if (failure) {
        await proc.stop();
        this.process = undefined;
        this.recordStartFailure(failure);
        throw new Error(failure);
      }
    }

    let transcript: TranscriptItem[] = [];
    try {
      const messagesRes = await proc.request({ type: 'get_messages', id: '' });
      if (messagesRes.success) {
        transcript = fromHistory((messagesRes.data as GetMessagesResponseData).messages);
      } else {
        console.error(`SessionAgent ${this.sessionId}: get_messages failed`, messagesRes.error);
      }
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: get_messages threw`, err);
    }

    this.runtime = {
      ...this.runtime,
      status: 'idle',
      stopReason: undefined,
      stopDetail: undefined,
      launchedMode: approvalMode,
      pendingMode: null,
      transcript,
    };

    await this.syncFromState(state);
    this.emitStatus();
    this.emitPatchReset();
  }

  /** Adds an error notice and moves the runtime to `stopped`/`start-failed` (data-model.md
   * "Reattach verification" step 3; also used by `restart()`'s failure paths), so a failed spawn
   * or reattach never leaves a blank chat. */
  private recordStartFailure(detail: string): void {
    const notice: TranscriptItem = { kind: 'notice', id: `notice-${this.runtime.transcript.length}-${Date.now()}`, level: 'error', text: detail };
    this.runtime = { ...this.runtime, transcript: [...this.runtime.transcript, notice] };
    this.setStatus('stopped', { stopReason: 'start-failed', stopDetail: detail });
    this.emitPatchReset();
  }

  /** Stops the whole agent process: idempotent, a no-op once already exited or never started.
   * Used by `SessionManager.stopAll()` and the future Stop-agent feature (T040); distinct from
   * `stop()`, which only aborts the running turn and leaves the process alive. */
  async shutdown(): Promise<void> {
    if (!this.process) return;
    await this.process.stop();
  }

  /** `settings.setApprovalMode` (T031, FR-015): marks a live Session whose `launchedMode` differs
   * from the new mode so it restarts at its own next settle; a no-op once stopped or already on
   * `mode`. */
  setPendingMode(mode: ApprovalMode): void {
    if (this.runtime.status === 'stopped' || this.runtime.launchedMode === mode) return;
    this.runtime = { ...this.runtime, pendingMode: mode };
    this.emitStatus();
  }

  /**
   * Restarts the process with the Settings store's current `--approval-mode` (T032, FR-020):
   * stop via `shutdown()`, respawn with `--resume <currentConversation>`, the same reattach
   * verification as `start()`, and a full transcript reload. Called once a Session with
   * `pendingMode` set reaches `session_settled` with no pending request. A failed verification
   * leaves the Session `stopped`/`start-failed` with an error notice (`recordStartFailure`); a
   * Session that is not live when the mode changes simply launches with it next time (`start()`
   * already reads the current Settings, not a captured one).
   */
  async restart(reason: string): Promise<void> {
    const session = this.requireSession();
    this.restarting = true;
    try {
      await this.shutdown();

      const approvalMode = this.settings.get().approvalMode;
      const proc = new OmpProcess({
        cwd: session.worktreePath,
        approvalMode,
        resumeFile: session.currentConversation ?? undefined,
        sessionId: session.id,
        ompPath: this.ompPath,
      });
      proc.on('frame', (frame: Frame) => this.onFrame(frame));
      proc.on('exit', (info: { code: number | null; requested: boolean }) => this.onExit(info));

      try {
        await proc.start();
      } catch (err) {
        this.recordStartFailure(`Restart failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.process = proc;

      let state: GetStateResponseData;
      try {
        const stateRes = await proc.request({ type: 'get_state', id: '' });
        if (!stateRes.success) {
          throw new Error(`get_state failed: ${stateRes.error ?? 'unknown error'}`);
        }
        state = stateRes.data as GetStateResponseData;
      } catch (err) {
        await proc.stop();
        this.process = undefined;
        this.recordStartFailure(`Restart failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      if (session.currentConversation) {
        const failure = this.verifyReattach(session, state);
        if (failure) {
          await proc.stop();
          this.process = undefined;
          this.recordStartFailure(`Restart failed (${reason}): ${failure}`);
          return;
        }
      }

      let transcript: TranscriptItem[] = [];
      try {
        const messagesRes = await proc.request({ type: 'get_messages', id: '' });
        if (messagesRes.success) {
          transcript = fromHistory((messagesRes.data as GetMessagesResponseData).messages);
        }
      } catch (err) {
        console.error(`SessionAgent ${this.sessionId}: get_messages after restart threw`, err);
      }

      this.runtime = {
        ...this.runtime,
        status: 'idle',
        stopReason: undefined,
        stopDetail: undefined,
        launchedMode: approvalMode,
        pendingMode: null,
        transcript,
      };
      await this.syncFromState(state);
      this.emitStatus();
      this.emitPatchReset();
    } finally {
      this.restarting = false;
    }
  }

  /** data-model.md "session_settled ... If pendingMode is set, run the mode-change restart."
   * Only once the turn is fully idle with nothing left answerable. */
  private maybeRestartForPendingMode(): void {
    if (this.runtime.pendingMode !== null && this.runtime.pending.length === 0 && this.runtime.status === 'idle') {
      void this.restart('approval mode change');
    }
  }

  /** `chat.send` (contracts/omp-usage.md "Send a message"): `message`, never `text`; a
   * `streamingBehavior:'followUp'` prompt while a turn is already running becomes a queue chip
   * instead of starting a second turn. `queued` reports which case this was. */
  async send(text: string): Promise<{ queued: boolean }> {
    if (!this.process) {
      throw new Error(`SessionAgent ${this.sessionId}: cannot send, no live process`);
    }
    const working = this.runtime.status === 'working' || this.runtime.status === 'needs-you';
    const res = working
      ? await this.process.request({ type: 'prompt', id: '', message: text, streamingBehavior: 'followUp' })
      : await this.process.request({ type: 'prompt', id: '', message: text });
    if (!res.success) {
      throw new Error(`SessionAgent ${this.sessionId}: prompt failed: ${res.error ?? 'unknown error'}`);
    }
    return { queued: working };
  }

  /** `chat.stop` (contracts/omp-usage.md "Stop"): sends `abort`, then waits for the turn to fully
   * settle (any `prompt_result` status, then `session_settled`) before the Session accepts
   * another prompt. A no-op while idle. */
  async stop(): Promise<void> {
    if (!this.process || this.runtime.status === 'idle') return;
    const res = await this.process.request({ type: 'abort', id: '' });
    if (!res.success) {
      console.error(`SessionAgent ${this.sessionId}: abort failed`, res.error);
    }
    await this.waitForIdle(ABORT_SETTLE_TIMEOUT_MS);
  }

  /** `chat.removeQueued`: hides the chip only when OMP reports `removed: true`. */
  async removeQueued(text: string): Promise<{ removed: boolean }> {
    if (!this.process) {
      throw new Error(`SessionAgent ${this.sessionId}: cannot remove a queued message, no live process`);
    }
    const res = await this.process.request({ type: 'remove_queued_message', id: '', message: text, queue: 'followUp' });
    return { removed: res.success && (res.data as { removed?: boolean } | undefined)?.removed === true };
  }

  /** `chat.sendNow` (contracts/omp-usage.md "Send now (steer)"): removes the queued chip, then
   * steers with the same text. If it had already left the queue on its own, does nothing more. */
  async sendNow(text: string): Promise<{ steered: boolean }> {
    if (!this.process) {
      throw new Error(`SessionAgent ${this.sessionId}: cannot send now, no live process`);
    }
    const removeRes = await this.process.request({ type: 'remove_queued_message', id: '', message: text, queue: 'followUp' });
    if (!(removeRes.success && (removeRes.data as { removed?: boolean } | undefined)?.removed === true)) {
      return { steered: false };
    }
    const steerRes = await this.process.request({ type: 'steer', id: '', message: text });
    return { steered: steerRes.success };
  }

  /** `conversations.startNew` (contracts/omp-usage.md "New Conversation"): same process, same
   * cwd, same Session; clears the transcript. `currentConversation` updates at the next settle,
   * once the first message of the new Conversation is written. */
  async startNewConversation(): Promise<void> {
    if (this.runtime.status !== 'idle' || !this.process) {
      throw new SessionNotIdleError(`SessionAgent ${this.sessionId}: cannot start a new Conversation while ${this.runtime.status}`);
    }
    const res = await this.process.request({ type: 'new_session', id: '' });
    if (!res.success) {
      throw new Error(`SessionAgent ${this.sessionId}: new_session failed: ${res.error ?? 'unknown error'}`);
    }
    this.runtime = { ...this.runtime, transcript: [] };
    this.emitPatchReset();
  }

  /** `conversations.open` (contracts/omp-usage.md "Open an earlier Conversation"): `cancelled`
   * must be `false`, then the same reattach verification as `start()`, reloading history with
   * `get_messages`. Verified against `file`, not the registry's current Conversation; no expected
   * message count is tracked per historical file, so that one check is skipped. */
  async openConversation(file: string): Promise<void> {
    if (this.runtime.status !== 'idle' || !this.process) {
      throw new SessionNotIdleError(`SessionAgent ${this.sessionId}: cannot open a Conversation while ${this.runtime.status}`);
    }
    const switchRes = await this.process.request({ type: 'switch_session', id: '', sessionPath: file });
    const cancelled = (switchRes.data as SwitchSessionResponseData | undefined)?.cancelled;
    if (!switchRes.success || cancelled !== false) {
      throw new ReattachFailedError(`SessionAgent ${this.sessionId}: switch_session failed or was cancelled for ${file}`);
    }
    const stateRes = await this.process.request({ type: 'get_state', id: '' });
    if (!stateRes.success) {
      throw new ReattachFailedError(`SessionAgent ${this.sessionId}: get_state after switch_session failed: ${stateRes.error ?? 'unknown error'}`);
    }
    const state = stateRes.data as GetStateResponseData;
    const session = this.requireSession();
    const failure = this.verifyReattach({ ...session, currentConversation: file, lastMessageCount: null }, state);
    if (failure) {
      throw new ReattachFailedError(failure);
    }
    const messagesRes = await this.process.request({ type: 'get_messages', id: '' });
    const transcript = messagesRes.success ? fromHistory((messagesRes.data as GetMessagesResponseData).messages) : [];
    this.runtime = { ...this.runtime, transcript };
    await this.syncFromState(state);
    this.emitPatchReset();
  }

  /** `chat.answer` (T028): writes the `extension_ui_response` for a still-pending request and
   * marks it resolved. Every `select`, `confirm`, `input`, and `editor` request must reach this
   * or `settleTurnPendingRequests` (constitution II). */
  async answerRequest(requestId: string, answer: ChatAnswer): Promise<void> {
    const request = this.runtime.pending.find((r) => r.requestId === requestId);
    if (!request) {
      throw new Error(`SessionAgent ${this.sessionId}: no pending request ${requestId}`);
    }
    if (!this.process) {
      throw new Error(`SessionAgent ${this.sessionId}: cannot answer, no live process`);
    }
    this.process.write(buildDialogResponse(requestId, request, answer));
    const resolved: 'approved' | 'denied' | 'answered' | 'cancelled' =
      'cancelled' in answer ? 'cancelled' : 'approve' in answer ? (answer.approve ? 'approved' : 'denied') : 'answered';
    this.resolvePendingRequest(requestId, resolved);
    if (this.runtime.pending.length === 0 && this.runtime.status === 'needs-you') {
      this.setStatus('working');
    }
  }

  /** data-model.md "Reattach verification (FR-013, FR-024)"; only called when resuming. */
  private verifyReattach(session: Session, state: GetStateResponseData): string | undefined {
    if (path.resolve(state.sessionFile).toLowerCase() !== path.resolve(session.currentConversation!).toLowerCase()) {
      return `Reattach verification failed: sessionFile mismatch (expected ${session.currentConversation}, got ${state.sessionFile})`;
    }
    if (!(state.messageCount > 0)) {
      return `Reattach verification failed: messageCount is ${state.messageCount}, expected greater than 0`;
    }
    if (session.lastMessageCount !== null && state.messageCount !== session.lastMessageCount) {
      return `Reattach verification failed: messageCount ${state.messageCount} does not match last known ${session.lastMessageCount}`;
    }
    return undefined;
  }

  /** Runs after the initial `get_state` and after every `session_settled` (data-model.md
   * "`sessionDir` is learned once ..."). */
  private async syncFromState(state: GetStateResponseData): Promise<void> {
    const session = this.registry.getSession(this.sessionId);
    if (!session) return;
    const patch: Partial<Session> = {
      lastMessageCount: state.messageCount,
      lastActivityAt: new Date().toISOString(),
      currentConversation: state.sessionFile,
    };
    if (session.sessionDir === null) {
      patch.sessionDir = path.dirname(state.sessionFile);
    }
    try {
      await this.registry.updateSession(this.sessionId, patch);
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: failed to update registry from get_state`, err);
    }
  }

  private async onSessionSettled(): Promise<void> {
    if (!this.process) return;
    try {
      const res = await this.process.request({ type: 'get_state', id: '' });
      if (!res.success) {
        console.error(`SessionAgent ${this.sessionId}: get_state after session_settled failed`, res.error);
        return;
      }
      await this.syncFromState(res.data as GetStateResponseData);
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: get_state after session_settled threw`, err);
    }
  }

  private onExit(info: { code: number | null; requested: boolean }): void {
    this.process = undefined;
    if (this.restarting) return; // restart() owns this transition; see its doc comment.
    this.settleTurnPendingRequests('Request withdrawn: the agent process exited.');
    if (info.requested) {
      this.setStatus('stopped', { stopReason: 'not-started' });
    } else {
      this.setStatus('stopped', { stopReason: 'agent-exited', stopDetail: `exit code ${String(info.code)}` });
    }
  }

  /**
   * Live rpc-ui frames: transcript patches (via `transcript.ts`), `queue_update`,
   * `available_commands_update`, dialogs (`extension_ui_request`), and the `agent_start`/
   * `session_settled` status transitions (data-model.md "State transitions").
   */
  private onFrame(frame: Frame): void {
    switch (frame.type) {
      case 'agent_start':
        this.setStatus('working');
        return;
      case 'session_settled':
        this.settleTurnPendingRequests('Request withdrawn: the turn ended.');
        this.setStatus('idle');
        void this.onSessionSettled().then(() => this.maybeRestartForPendingMode());
        return;
      case 'prompt_result':
        this.applyTranscriptFrame(frame);
        if (frame.sessionSettled === true) {
          this.settleTurnPendingRequests('Request withdrawn: the turn ended.');
          this.setStatus('idle');
          void this.onSessionSettled().then(() => this.maybeRestartForPendingMode());
        }
        return;
      case 'queue_update': {
        // Same reason as OmpProcess.ts's dispatchFrame: `type` narrowing alone can't isolate
        // QueueUpdateFrame here, because UnknownFrame's index signature accepts any key.
        const queueFrame = frame as QueueUpdateFrame;
        this.setQueue(queueFrame.followUp, queueFrame.steering);
        return;
      }
      case 'available_commands_update': {
        const commandsFrame = frame as AvailableCommandsUpdateFrame;
        this.commands = commandsFrame.commands;
        this.emit('commands', { sessionId: this.sessionId, commands: commandsFrame.commands });
        return;
      }
      case 'extension_ui_request': {
        const dialogFrame = frame as ExtensionUiRequestFrame;
        const classified = classifyDialog(dialogFrame);
        if (classified === 'ignore') return;
        if ('cancel' in classified) {
          if (this.runtime.pending.some((r) => r.requestId === classified.cancel)) {
            this.resolvePendingRequest(classified.cancel, 'cancelled');
            this.appendNotice('Request withdrawn: the agent cancelled it.');
            if (this.runtime.pending.length === 0 && this.runtime.status === 'needs-you') {
              this.setStatus('working');
            }
          }
          return;
        }
        this.addPendingRequest(classified);
        return;
      }
      case 'message_start':
      case 'message_update':
      case 'message_end':
      case 'tool_execution_start':
      case 'tool_execution_end':
      case 'command_output':
      case 'notice':
        this.applyTranscriptFrame(frame);
        return;
      default:
        // agent_end (Pinion tracks history incrementally, not from the final snapshot),
        // rpc_chunk/response (consumed inside OmpProcess and never emitted as 'frame'), and
        // unrecognised frame types: no-op.
        return;
    }
  }

  private applyTranscriptFrame(frame: Frame): void {
    const next = applyFrame(this.runtime.transcript, frame);
    if (next === this.runtime.transcript) return;
    const ops = diffTranscript(this.runtime.transcript, next);
    this.runtime = { ...this.runtime, transcript: next };
    if (ops.length > 0) this.queuePatch(ops);
  }

  private setQueue(followUp: string[], steering: string[]): void {
    this.runtime = { ...this.runtime, queue: { followUp, steering } };
    this.emit('queue', { sessionId: this.sessionId, followUp, steering });
  }

  private addPendingRequest(request: PendingRequest): void {
    this.runtime = { ...this.runtime, pending: [...this.runtime.pending, request], status: 'needs-you' };
    this.upsertTranscriptItem({ kind: 'request', id: `request:${request.requestId}`, requestId: request.requestId });
    this.emit('request', { sessionId: this.sessionId, request });
    this.emitStatus();
  }

  private resolvePendingRequest(requestId: string, resolved: 'approved' | 'denied' | 'answered' | 'cancelled'): void {
    this.upsertTranscriptItem({ kind: 'request', id: `request:${requestId}`, requestId, resolved });
    this.runtime = { ...this.runtime, pending: this.runtime.pending.filter((r) => r.requestId !== requestId) };
    this.emit('requestResolved', { sessionId: this.sessionId, requestId });
  }

  /** Withdraws every currently pending request (the turn ending or the process exiting), each
   * marked `resolved: 'cancelled'`, plus one explanatory notice. */
  private settleTurnPendingRequests(reason: string): void {
    if (this.runtime.pending.length === 0) return;
    for (const request of this.runtime.pending) {
      this.upsertTranscriptItem({ kind: 'request', id: `request:${request.requestId}`, requestId: request.requestId, resolved: 'cancelled' });
      this.emit('requestResolved', { sessionId: this.sessionId, requestId: request.requestId });
    }
    this.runtime = { ...this.runtime, pending: [] };
    this.appendNotice(reason);
  }

  private upsertTranscriptItem(item: TranscriptItem): void {
    const exists = this.runtime.transcript.some((existing) => existing.id === item.id);
    const transcript = exists
      ? this.runtime.transcript.map((existing) => (existing.id === item.id ? item : existing))
      : [...this.runtime.transcript, item];
    this.runtime = { ...this.runtime, transcript };
    this.queuePatch([{ op: 'upsert', item }]);
  }

  private appendNotice(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.upsertTranscriptItem({ kind: 'notice', id: `notice-${this.runtime.transcript.length}-${Date.now()}`, level, text });
  }

  /** T037: a Session that finishes (`working` -> `idle`) while it is not the visible Session, or
   * no Pinion window is focused, becomes `unread`; cleared by `clearUnread()` when it becomes
   * visible. */
  private setStatus(status: SessionStatus, extra?: { stopReason?: SessionRuntime['stopReason']; stopDetail?: string }): void {
    const becameUnread = this.runtime.status === 'working' && status === 'idle' && (!this.isVisible() || !this.isWindowFocused());
    this.runtime = {
      ...this.runtime,
      status,
      stopReason: extra?.stopReason,
      stopDetail: extra?.stopDetail,
      unread: becameUnread ? true : this.runtime.unread,
    };
    this.emitStatus();
  }

  /** Clears `unread` once this Session becomes the visible one (T037); a no-op if already clear. */
  clearUnread(): void {
    if (!this.runtime.unread) return;
    this.runtime = { ...this.runtime, unread: false };
    this.emitStatus();
  }

  private emitStatus(): void {
    const payload: SessionStatusEvent = {
      sessionId: this.sessionId,
      status: this.runtime.status,
      stopReason: this.runtime.stopReason,
      stopDetail: this.runtime.stopDetail,
      unread: this.runtime.unread,
      pendingMode: this.runtime.pendingMode,
    };
    this.emit('status', payload);
  }

  /** Full-snapshot flush, used at the end of `start()`, `startNewConversation()`, and
   * `openConversation()` (contracts/ipc.md "a final flush when a Session becomes visible"). */
  private emitPatchReset(): void {
    this.emit('patch', { sessionId: this.sessionId, ops: [{ op: 'reset', items: this.runtime.transcript }] });
  }

  private queuePatch(ops: TranscriptOp[]): void {
    this.pendingOps.push(...ops);
    if (this.patchTimer) return;
    this.patchTimer = setTimeout(() => {
      this.patchTimer = undefined;
      const flushed = this.pendingOps;
      this.pendingOps = [];
      if (flushed.length === 0) return;
      this.emit('patch', { sessionId: this.sessionId, ops: flushed });
    }, PATCH_COALESCE_MS);
  }

  /** Resolves once the Session reaches `idle`, used by `stop()` after sending `abort`. */
  private waitForIdle(timeoutMs: number): Promise<void> {
    if (this.runtime.status === 'idle') return Promise.resolve();
    // Promise.withResolvers() would read cleaner here, but it needs lib "ES2024" and
    // tsconfig.node.json is pinned to "ES2023" (see OmpProcess.ts's start()); executor form kept.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('status', onStatus);
        reject(new Error(`SessionAgent ${this.sessionId}: timed out waiting for idle`));
      }, timeoutMs);
      const onStatus = (payload: SessionStatusEvent): void => {
        if (payload.status !== 'idle') return;
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve();
      };
      this.on('status', onStatus);
    });
  }
}

/**
 * Builds the `TranscriptOp[]` to bring a subscriber from `prev` to `next`. `transcript.ts`
 * preserves object identity for items it did not touch (see `replaceMessageItems`), so an
 * unchanged item is the same reference in both arrays; anything new or changed is a fresh object
 * and becomes an `upsert`. If any item present in `prev` is gone from `next` (no `TranscriptOp`
 * models deletion), the whole snapshot is resent as a `reset`.
 */
function diffTranscript(prev: TranscriptItem[], next: TranscriptItem[]): TranscriptOp[] {
  if (prev.length === 0) {
    return next.length === 0 ? [] : [{ op: 'reset', items: next }];
  }
  const nextIds = new Set(next.map((item) => item.id));
  const anyRemoved = prev.some((item) => !nextIds.has(item.id));
  if (anyRemoved) {
    return [{ op: 'reset', items: next }];
  }
  const ops: TranscriptOp[] = [];
  for (const item of next) {
    const before = prev.find((candidate) => candidate.id === item.id);
    if (!before || before !== item) {
      ops.push({ op: 'upsert', item });
    }
  }
  return ops;
}
