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
import { AgentNotRunningError, PromptFailedError, ReattachFailedError, SessionNotIdleError } from './errors';
import { diffTranscript, finalizeLiveTranscript, mergeLiveTranscript } from './transcriptDiff';
import { bailIfStopRequested, stopIfRunning } from './launchStopGuard';
import { PatchCoalescer } from './patchCoalescer';
import { verifyReattach } from './reattachVerification';
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

const ABORT_SETTLE_TIMEOUT_MS = 60_000;

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

  private readonly patches = new PatchCoalescer((ops) => this.emit('patch', { sessionId: this.sessionId, ops }));
  /** True only while `restart()` is tearing down and respawning the process, so `onExit`'s
   * normal agent-exited handling (status flip, notice) is skipped in favour of `restart()`'s own,
   * quieter transition (FR-020: a mode-change restart must not look like a crash). While true,
   * `send()`/`stop()` refuse with a clear error instead of racing the process swap. */
  private restarting = false;
  /** In-flight `start()`/`restart()` calls, so a second concurrent call (e.g. two rapid
   * `sessions.open`, or `session_settled` and a late `prompt_result` both trying to restart)
   * joins the same attempt instead of spawning a second `omp` process. */
  private startPromise: Promise<void> | undefined;
  private restartPromise: Promise<void> | undefined;
  private stopRequested = false;
  /** Guards the settle sequence (`settleTurnPendingRequests`/`setStatus('idle')`/
   * `onSessionSettled`) against running twice for one turn end: OMP can deliver both
   * `prompt_result.sessionSettled:true` and a separate `session_settled` frame for the same
   * turn. Reset at the next `agent_start`. */
  private turnSettleHandled = false;

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
   * A second concurrent call (e.g. two rapid `sessions.open`) joins the same attempt instead of
   * spawning a second `omp` process.
   */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.process) throw new Error(`SessionAgent ${this.sessionId}: already started`);
    if (this.runtime.status === 'stopped') this.stopRequested = false;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined;
      this.maybeRestartForPendingMode();
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const session = this.requireSession();

    if (!(await fs.stat(session.worktreePath).then(() => true, () => false))) {
      this.setStatus('stopped', { stopReason: 'worktree-missing', stopDetail: session.worktreePath });
      throw new Error(`Worktree missing: ${session.worktreePath}`);
    }

    const result = await this.launch(session, '');
    if (!result.ok) throw result.error;
  }

  /** Shared spawn/reattach/history-reload sequence for `doStart()` and `doRestart()`: create the
   * `OmpProcess`, start it, reattach via `attachAndVerify`, reload history, and bring the runtime
   * to `idle`. `failurePrefix` distinguishes a fresh start's notice text from a restart's. */
  private async launch(session: Session, failurePrefix: string): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const approvalMode = this.settings.get().approvalMode;
    const proc = new OmpProcess({
      cwd: session.worktreePath,
      approvalMode,
      sessionId: session.id,
      ompPath: this.ompPath,
    });
    proc.on('frame', (frame: Frame) => this.onFrame(frame));
    proc.on('exit', (info: { code: number | null; requested: boolean }) => this.onExit(info));

    try {
      await proc.start();
    } catch (err) {
      // A failed handshake (ready timeout, negotiate failure, spawn error) must never leave a
      // child behind: `this.process` was never set, so nothing else will ever stop it.
      await proc.stop();
      this.recordStartFailure(failurePrefix + (err instanceof Error ? err.message : String(err)));
      return { ok: false, error: err };
    }
    this.process = proc;
    const bail1 = await bailIfStopRequested(this.stopRequested, proc, () => {
      this.process = undefined;
      this.setStatus('stopped', { stopReason: 'not-started' });
    });
    if (bail1) return bail1;
    let state: GetStateResponseData;
    try {
      state = await this.attachAndVerify(proc, session);
    } catch (err) {
      await proc.stop();
      this.process = undefined;
      this.recordStartFailure(failurePrefix + (err instanceof Error ? err.message : String(err)));
      return { ok: false, error: err };
    }
    const bail2 = await bailIfStopRequested(this.stopRequested, proc, () => {
      this.process = undefined;
      this.setStatus('stopped', { stopReason: 'not-started' });
    });
    if (bail2) return bail2;
    let transcript: TranscriptItem[] = [];
    let messagesOk = false;
    try {
      const messagesRes = await proc.request({ type: 'get_messages', id: '' });
      if (messagesRes.success) {
        transcript = fromHistory((messagesRes.data as GetMessagesResponseData).messages);
        messagesOk = true;
      } else {
        console.error(`SessionAgent ${this.sessionId}: get_messages failed`, messagesRes.error);
      }
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: get_messages threw`, err);
    }
    if (this.process !== proc) {
      const detail = failurePrefix + 'agent exited during start';
      this.recordStartFailure(detail);
      return { ok: false, error: new Error(detail) };
    }

    const currentMode = this.settings.get().approvalMode;
    this.runtime = {
      ...this.runtime,
      status: 'idle',
      stopReason: undefined,
      stopDetail: undefined,
      launchedMode: approvalMode,
      pendingMode: currentMode === approvalMode ? null : currentMode,
      transcript: messagesOk ? mergeLiveTranscript(transcript, this.runtime.transcript) : this.runtime.transcript,
    };

    await this.syncFromState(state);
    this.emitStatus();
    this.emitPatchReset();
    this.maybeRestartForPendingMode();
    return { ok: true };
  }

  /**
   * Attaches `proc` to `session.currentConversation` via `switch_session`, then `get_state` and
   * the reattach verification; both are skipped when there is no Conversation yet. Deliberately
   * not `--resume` at launch: proven equally valid for a normal restart (FINDINGS C16), but a
   * `git worktree remove` followed by `git worktree add` at the same path (T043's
   * `recreateWorktree`) leaves `--resume` unable to find the real history -- it silently starts
   * a blank session at that filename and overwrites it there on exit -- while `switch_session`
   * against the same file, same process, same cwd attaches correctly (verified live,
   * 2026-09-30). Throws on any failure; the caller stops `proc` and records it.
   */
  private async attachAndVerify(proc: OmpProcess, session: Session): Promise<GetStateResponseData> {
    if (session.currentConversation) {
      const switchRes = await proc.request({ type: 'switch_session', id: '', sessionPath: session.currentConversation });
      const cancelled = (switchRes.data as SwitchSessionResponseData | undefined)?.cancelled;
      if (!switchRes.success || cancelled !== false) {
        throw new Error(`switch_session failed or was cancelled for ${session.currentConversation}`);
      }
    }
    const stateRes = await proc.request({ type: 'get_state', id: '' });
    if (!stateRes.success) {
      throw new Error(`get_state failed: ${stateRes.error ?? 'unknown error'}`);
    }
    const state = stateRes.data as GetStateResponseData;
    if (session.currentConversation) {
      const failure = verifyReattach(session, state);
      if (failure) throw new Error(failure);
    }
    return state;
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
   * Marks `stopRequested` and drains any in-flight `start()`/`restart()` before stopping the
   * process (`launchStopGuard.ts`); distinct from `stop()`, which only aborts the running turn. */
  async shutdown(): Promise<void> {
    this.stopRequested = true;
    while (this.startPromise || this.restartPromise) {
      await (this.startPromise ?? this.restartPromise)?.catch(() => undefined);
    }
    await stopIfRunning(this.process);
  }

  /** `settings.setApprovalMode` (T031, FR-015): marks a live Session whose `launchedMode` differs
   * so it restarts once idle with no pending request -- immediately, if that is already true now,
   * otherwise at its next settle (`maybeRestartForPendingMode`). Reverting to the already-running
   * `launchedMode` before a pending change applied clears it with no restart. A no-op once
   * stopped. */
  setPendingMode(mode: ApprovalMode): void {
    if (this.runtime.status === 'stopped') return;
    if (this.runtime.launchedMode === mode) {
      if (this.runtime.pendingMode === null) return;
      this.runtime = { ...this.runtime, pendingMode: null };
      this.emitStatus();
      return;
    }
    this.runtime = { ...this.runtime, pendingMode: mode };
    this.emitStatus();
    this.maybeRestartForPendingMode();
  }

  /**
   * Restarts the process with the Settings store's current `--approval-mode` (T032, FR-020):
   * stop via an internal `stopIfRunning`, respawn, reattach via `attachAndVerify`, and a full
   * reload. Called once a Session with `pendingMode` set reaches `session_settled` with no
   * pending request. A failed verification leaves the Session `stopped`/`start-failed` with an
   * error notice (`recordStartFailure`); a Session that is not live when the mode changes simply
   * launches with it next time (`start()` already reads the current Settings, not a captured
   * one). A second concurrent call joins the same attempt instead of spawning a second process.
   */
  async restart(reason: string): Promise<void> {
    if (this.restartPromise) return this.restartPromise;
    if (this.runtime.status === 'stopped') this.stopRequested = false;
    this.restartPromise = this.doRestart(reason).finally(() => {
      this.restartPromise = undefined;
      this.maybeRestartForPendingMode();
    });
    return this.restartPromise;
  }

  private async doRestart(reason: string): Promise<void> {
    const session = this.requireSession();
    this.restarting = true;
    try {
      await stopIfRunning(this.process);
      const result = await this.launch(session, `Restart failed (${reason}): `);
      if (!result.ok) return;
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
    if (this.restarting) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot send, restart in progress`);
    }
    if (!this.process) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot send, no live process`);
    }
    const working = this.runtime.status === 'working' || this.runtime.status === 'needs-you';
    const res = working
      ? await this.process.request({ type: 'prompt', id: '', message: text, streamingBehavior: 'followUp' })
      : await this.process.request({ type: 'prompt', id: '', message: text });
    if (!res.success) {
      this.appendNotice(`prompt failed: ${res.error ?? 'unknown error'}`, 'error');
      throw new PromptFailedError(`SessionAgent ${this.sessionId}: prompt failed: ${res.error ?? 'unknown error'}`);
    }
    return { queued: working };
  }

  /** `chat.stop` (contracts/omp-usage.md "Stop"): sends `abort`, then waits for the turn to fully
   * settle (any `prompt_result` status, then `session_settled`) before the Session accepts
   * another prompt. A no-op while idle. */
  async stop(): Promise<void> {
    if (this.restarting) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot stop, restart in progress`);
    }
    if (!this.process || this.runtime.status === 'idle') return;
    const res = await this.process.request({ type: 'abort', id: '' });
    if (!res.success) {
      this.appendNotice(`abort failed: ${res.error ?? 'unknown error'}`, 'error');
    }
    await this.waitForIdle(ABORT_SETTLE_TIMEOUT_MS);
  }

  /** `chat.removeQueued`: hides the chip only when OMP reports `removed: true`. */
  async removeQueued(text: string): Promise<{ removed: boolean }> {
    if (!this.process) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot remove a queued message, no live process`);
    }
    const res = await this.process.request({ type: 'remove_queued_message', id: '', message: text, queue: 'followUp' });
    if (!res.success) {
      this.appendNotice(`remove_queued_message failed: ${res.error ?? 'unknown error'}`, 'error');
    }
    return { removed: res.success && (res.data as { removed?: boolean } | undefined)?.removed === true };
  }

  /** `chat.sendNow` (contracts/omp-usage.md "Send now (steer)"): removes the queued chip, then
   * steers with the same text. If it had already left the queue on its own, does nothing more. */
  async sendNow(text: string): Promise<{ steered: boolean }> {
    if (!this.process) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot send now, no live process`);
    }
    const removeRes = await this.process.request({ type: 'remove_queued_message', id: '', message: text, queue: 'followUp' });
    if (!removeRes.success) {
      this.appendNotice(`remove_queued_message failed: ${removeRes.error ?? 'unknown error'}`, 'error');
    }
    if (!(removeRes.success && (removeRes.data as { removed?: boolean } | undefined)?.removed === true)) {
      return { steered: false };
    }
    const steerRes = await this.process.request({ type: 'steer', id: '', message: text });
    if (!steerRes.success) {
      this.appendNotice(`steer failed: ${steerRes.error ?? 'unknown error'}`, 'error');
    }
    return { steered: steerRes.success };
  }

  /** `conversations.startNew` (contracts/omp-usage.md "New Conversation"): same process, same
   * cwd, same Session; clears the transcript. No Conversation is current until the first message
   * of the new one is written (OMP creates the file lazily), so `currentConversation` is cleared
   * to `null` here; `syncFromState` sets it to the new file at the next settle. */
  async startNewConversation(): Promise<void> {
    if (this.runtime.status !== 'idle' || !this.process) {
      throw new SessionNotIdleError(`SessionAgent ${this.sessionId}: cannot start a new Conversation while ${this.runtime.status}`);
    }
    const res = await this.process.request({ type: 'new_session', id: '' });
    if (!res.success) {
      throw new Error(`SessionAgent ${this.sessionId}: new_session failed: ${res.error ?? 'unknown error'}`);
    }
    try {
      await this.registry.updateSession(this.sessionId, { currentConversation: null, lastMessageCount: null });
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: failed to clear currentConversation after new_session`, err);
    }
    this.runtime = { ...this.runtime, transcript: [] };
    this.emitPatchReset();
  }

  /** `conversations.open` (contracts/omp-usage.md "Open an earlier Conversation"): `cancelled`
   * must be `false`, then the same reattach verification as `start()`, reloading history with
   * `get_messages` and using it AS-IS, not merged with the old live transcript -- this switches
   * to a DIFFERENT Conversation (only possible while idle, so nothing is pending to carry over),
   * and merging would wrongly drag resolved cards from the PRIOR Conversation into this one.
   * Verified against `file`, not the registry's current Conversation; no expected message count
   * is tracked per historical file, so that one check is skipped. */
  async openConversation(file: string): Promise<void> {
    if (this.runtime.status !== 'idle' || !this.process) {
      throw new SessionNotIdleError(`SessionAgent ${this.sessionId}: cannot open a Conversation while ${this.runtime.status}`);
    }
    const session = this.requireSession();
    const previousConversation = session.currentConversation;

    const switchRes = await this.process.request({ type: 'switch_session', id: '', sessionPath: file });
    const cancelled = (switchRes.data as SwitchSessionResponseData | undefined)?.cancelled;
    if (!switchRes.success || cancelled !== false) {
      // switch_session itself failed or was cancelled: OMP never actually rebinds the process in
      // that case, so it is still on `previousConversation` -- nothing to recover.
      throw new ReattachFailedError(`SessionAgent ${this.sessionId}: switch_session failed or was cancelled for ${file}`);
    }

    // From here the live process IS bound to `file`; any further failure must not leave it there
    // while the registry still points at `previousConversation` (security fix: the live process
    // and the registry must never disagree about the current Conversation).
    const stateRes = await this.process.request({ type: 'get_state', id: '' });
    const failure = !stateRes.success
      ? `get_state after switch_session failed: ${stateRes.error ?? 'unknown error'}`
      : verifyReattach({ ...session, currentConversation: file, lastMessageCount: null }, stateRes.data as GetStateResponseData);
    if (failure) {
      await this.recoverFromFailedSwitch(previousConversation, file, failure);
      throw new ReattachFailedError(failure);
    }

    const state = stateRes.data as GetStateResponseData;
    const messagesRes = await this.process.request({ type: 'get_messages', id: '' });
    const transcript = messagesRes.success ? fromHistory((messagesRes.data as GetMessagesResponseData).messages) : [];
    this.runtime = { ...this.runtime, transcript };
    await this.syncFromState(state);
    this.emitPatchReset();
  }

  /** Restores consistency after `openConversation` fails its post-switch verification: the live
   * process must never stay bound to `attemptedFile` while the registry still points at
   * `previousConversation`. Tries switching back to the prior Conversation first -- reloading its
   * history as-is, not merged with the old live transcript (same reasoning as `openConversation`)
   * -- if that also fails to verify (or there was no prior Conversation), stops the process and
   * marks the Session `stopped`/`start-failed` instead of leaving it pointed at the wrong file. */
  private async recoverFromFailedSwitch(previousConversation: string | null, attemptedFile: string, reason: string): Promise<void> {
    if (!this.process) return;
    if (previousConversation) {
      try {
        const backRes = await this.process.request({ type: 'switch_session', id: '', sessionPath: previousConversation });
        const backCancelled = (backRes.data as SwitchSessionResponseData | undefined)?.cancelled;
        if (backRes.success && backCancelled === false) {
          const backStateRes = await this.process.request({ type: 'get_state', id: '' });
          if (backStateRes.success) {
            const session = this.requireSession();
            const backFailure = verifyReattach(session, backStateRes.data as GetStateResponseData);
            if (!backFailure) {
              const messagesRes = await this.process.request({ type: 'get_messages', id: '' });
              const transcript = messagesRes.success ? fromHistory((messagesRes.data as GetMessagesResponseData).messages) : [];
              this.runtime = { ...this.runtime, transcript };
              this.emitPatchReset();
              return;
            }
          }
        }
      } catch (err) {
        console.error(`SessionAgent ${this.sessionId}: failed to switch back after a failed openConversation`, err);
      }
    }
    await this.process.stop().catch(() => undefined);
    this.process = undefined;
    this.recordStartFailure(`openConversation(${attemptedFile}) failed reattach verification (${reason}), and recovery to the prior Conversation also failed`);
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

  /** Runs after the initial `get_state` and after every `session_settled` (data-model.md
   * "`sessionDir` is learned once ..."). `currentConversation`/`lastMessageCount` stay `null`
   * until `messageCount > 0`: `get_state` reports a `sessionFile` even before the first message
   * (OMP creates it lazily), and recording it early would later fail reattach verification's
   * own "`messageCount` must be > 0" check against a Conversation that never really existed. */
  private async syncFromState(state: GetStateResponseData): Promise<void> {
    const session = this.registry.getSession(this.sessionId);
    if (!session) return;
    const patch: Partial<Session> = { lastActivityAt: new Date().toISOString() };
    if (session.sessionDir === null) {
      patch.sessionDir = path.dirname(state.sessionFile);
    }
    if (state.messageCount > 0) {
      patch.lastMessageCount = state.messageCount;
      patch.currentConversation = state.sessionFile;
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

  /** Runs the turn-end settle sequence at most once per turn: OMP can deliver both
   * `prompt_result.sessionSettled:true` and a separate `session_settled` frame for the same
   * turn end, and running this twice would double-fire `onSessionSettled`'s registry sync and
   * `maybeRestartForPendingMode`'s restart check. */
  private handleTurnSettled(): void {
    if (this.turnSettleHandled) return;
    this.turnSettleHandled = true;
    this.settleTurnPendingRequests('Request withdrawn: the turn ended.');
    this.setStatus('idle');
    void this.onSessionSettled().then(() => this.maybeRestartForPendingMode());
  }

  private onExit(info: { code: number | null; requested: boolean }): void {
    this.process = undefined;
    this.finalizeLiveItems();
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
        this.turnSettleHandled = false;
        this.setStatus('working');
        return;
      case 'session_settled':
        this.handleTurnSettled();
        return;
      case 'prompt_result':
        this.applyTranscriptFrame(frame);
        if (frame.sessionSettled === true) {
          this.handleTurnSettled();
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
        if ('notify' in classified) {
          this.appendNotice(classified.notify.message, classified.notify.level);
          return;
        }
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

  /** Settles any tool/streaming item the just-ended process can never finish -- see
   * `finalizeLiveTranscript`'s doc comment for why this matters to `mergeLiveTranscript`. */
  private finalizeLiveItems(): void {
    const next = finalizeLiveTranscript(this.runtime.transcript);
    if (next === this.runtime.transcript) return;
    const ops = diffTranscript(this.runtime.transcript, next);
    this.runtime = { ...this.runtime, transcript: next };
    this.queuePatch(ops);
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
   * `openConversation()` (contracts/ipc.md "a final flush when a Session becomes visible").
   * See `PatchCoalescer.reset` for why any still-pending coalesced ops are dropped first. */
  private emitPatchReset(): void {
    this.patches.reset(this.runtime.transcript);
  }

  private queuePatch(ops: TranscriptOp[]): void {
    this.patches.queue(ops);
  }

  /** Resolves once the Session reaches `idle` -- or `stopped`, if the process exits mid-abort,
   * since it will then never reach `idle` and the caller must not wait out the full timeout for
   * something that has already definitively happened. Used by `stop()` after sending `abort`. */
  private waitForIdle(timeoutMs: number): Promise<void> {
    if (this.runtime.status === 'idle' || this.runtime.status === 'stopped') return Promise.resolve();
    // Promise.withResolvers() would read cleaner here, but it needs lib "ES2024" and
    // tsconfig.node.json is pinned to "ES2023" (see OmpProcess.ts's start()); executor form kept.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('status', onStatus);
        reject(new Error(`SessionAgent ${this.sessionId}: timed out waiting for idle`));
      }, timeoutMs);
      const onStatus = (payload: SessionStatusEvent): void => {
        if (payload.status !== 'idle' && payload.status !== 'stopped') return;
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve();
      };
      this.on('status', onStatus);
    });
  }
}
