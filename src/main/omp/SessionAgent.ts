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
import { applyFrame, currentTurnKeys, fromHistory, tryBuildAgentMessageFromUnknownFrame } from './transcript';
import { classifyDialog, buildDialogResponse } from './dialogs';
import { AgentNotRunningError, PromptFailedError, ReattachFailedError, SessionNotIdleError } from './errors';
import { diffTranscript, finalizeLiveTranscript, mergeLiveTranscript } from './transcriptDiff';
import { bailIfStopRequested, exitedDuringStart, stopIfRunning } from './launchStopGuard';
import { PatchCoalescer } from './patchCoalescer';
import { assertConversationFileExists, reattachRebaselineNotice, verifyReattach } from './reattachVerification';
import { recoverFromFailedSwitch } from './switchRecovery';
import { detectUnexpectedTermination } from './terminationDetection';
import { waitForIdleStatus } from './statusWait';
import { fetchAllMessages } from './fetchAllMessages';
import { shouldApplyCrashExitVerdict } from './exitVerdictGuard';
import { clearStoppedOnRequestMarker, recordStoppedOnRequestMarker } from './stoppedOnRequestMarker';
import type {
  AvailableCommandsUpdateFrame,
  ExtensionUiRequestFrame,
  Frame,
  GetStateResponseData,
  ImageContent,
  PredictWordResponseData,
  QueueKind,
  QueueUpdateFrame,
  SwitchSessionResponseData,
  ToolExecutionEndFrame,
  ToolExecutionStartFrame,
  ToolExecutionUpdateFrame,
} from '../../shared/frames';
import type { ApprovalMode, PendingRequest, Session, SessionReadout, SessionRuntime, SessionStatus, SubagentSummary, TranscriptItem } from '../../shared/model';
import type { ChatAnswer, SessionStatusEvent, SlashCommand, TranscriptOp } from '../../shared/ipc';
import { filterSupportedCommands } from '../../shared/slash-commands';
import type { RegistryStore } from '../store/registry';
import type { SettingsStore } from '../store/settings';
import { assembleReadout } from './readout';
import type { ReadoutState } from './readout';
import { applySubagentProgress } from './subagentStream';
import { pullRequestForBranch } from '../git/github';

const ABORT_SETTLE_TIMEOUT_MS = 60_000;
/** `predict_word`'s own worst case (rpc.md "Word prediction": "about two minutes" for a cold
 * shared prediction daemon start, FINDINGS item 28) exceeds `OmpProcess.request`'s 60 s default
 * timeout, so ghost text gets its own longer allowance instead of being treated as a failure. */
const PREDICT_WORD_TIMEOUT_MS = 150_000;

/** Security audit finding (2026-10-03, Medium): `get_state.model` is cast from OMP's own JSON
 * output (`res.data as GetStateResponseData`), not runtime-validated -- a malformed value (any
 * non-string field) used to be stored verbatim in the registry and crashed the renderer's
 * `formatModelLabel`/`formatThinkingLevelLabel` on every later read, persisting across a restart.
 * Capped length guards against one session's registry row growing unboundedly from a single oversized field. */
const MAX_MODEL_FIELD_LENGTH = 256;

/** Spec 004 contracts/ipc.md `readout:update`: coalesced to at most one per Session per this
 * window, matching `transcript:patch`'s own discipline (patchCoalescer.ts). */
const READOUT_COALESCE_MS = 50;

/** Spec 004 research.md decision: the pull-request chip is "polled on a timer" since no OMP
 * frame ever signals a GitHub-side PR change; my default, not confirmed with Stuart. */
const PR_POLL_INTERVAL_MS = 60_000;

/** The chip row's bundle before any readout has ever been assembled (data-model.md: every field
 * `null` means "not yet read" / "chip hidden", never a guessed value). */
const EMPTY_READOUT: SessionReadout = {
  changes: null,
  contextUsage: null,
  turnTime: null,
  pullRequest: null,
  subagentCount: null,
  todoProgress: null,
};

function isValidModelRef(model: unknown): model is { provider: string; id: string; name?: string } {
  if (typeof model !== 'object' || model === null) return false;
  const { provider, id, name } = model as Record<string, unknown>;
  return (
    typeof provider === 'string' &&
    provider.length > 0 &&
    typeof id === 'string' &&
    id.length > 0 &&
    (name === undefined || typeof name === 'string')
  );
}

export interface SessionAgentEvents {
  status: (payload: SessionStatusEvent) => void;
  patch: (payload: { sessionId: string; ops: TranscriptOp[] }) => void;
  queue: (payload: { sessionId: string; followUp: string[]; steering: string[] }) => void;
  request: (payload: { sessionId: string; request: PendingRequest }) => void;
  requestResolved: (payload: { sessionId: string; requestId: string }) => void;
  commands: (payload: { sessionId: string; commands: SlashCommand[] }) => void;
  /** Spec 004 `readout:update`: the chip row's live bundle, coalesced per READOUT_COALESCE_MS. */
  readout: (payload: { sessionId: string; readout: SessionReadout }) => void;
  /** Spec 004 `subagents:update`: the current turn's subagent list, whole-array replace. */
  subagents: (payload: { sessionId: string; subagents: SubagentSummary[] }) => void;
  /** Spec 004 `subagent:patch`: only for whichever subagent `setVisibleSubagent` last named. */
  subagentPatch: (payload: { sessionId: string; subagentId: string; ops: TranscriptOp[] }) => void;
  /** Fired whenever `syncFromState` writes a registry patch (after the initial `get_state`, every
   * `session_settled`, a Conversation switch, or a mode-change restart) -- i.e. whenever
   * `lastModel`/`lastThinkingLevel`/`currentConversation`/... may have changed. `SessionManager`
   * turns this into `notifyListChanged()` so the renderer's cached `sessions.list()` row (read by
   * the message box) never goes stale after the Session's first start (issues #84/#85). */
  registryUpdated: (payload: { sessionId: string }) => void;
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
  /** T037: whether any Refract window currently has OS focus; owned by `SessionManager`. */
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
  /** Quality-gate fix (cycle 3, 2026-10-08): bumped at the top of every `launch()` attempt.
   * `onExit`'s crash branch captures this before its own `await`; if a NEWER life has since
   * started by the time that resolves, this exit's "agent-exited" verdict is for a life nobody
   * cares about any more and must never overwrite whatever the newer life has since recorded. */
  private lifeEpoch = 0;
  /** Quality-gate fix (cycle 5, 2026-10-08): the in-flight `recordStoppedOnRequestMarker`/
   * `clearStoppedOnRequestMarker` write, if any -- `onExit`'s requested branch and `launch()`
   * both used to fire these without awaiting them, so quitting the app (`shutdown()` -> `before-
   * quit` -> `app.quit()`) could exit before a requested stop's marker ever reached disk, exactly
   * the restart case cycle 4 was meant to protect. `shutdown()` now awaits this before returning,
   * so `stopAll()` (and so `before-quit`) genuinely waits for it. Starts resolved so an agent
   * that never recorded or cleared anything has nothing to wait on. */
  private markerWrite: Promise<void> = Promise.resolve();

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
  /** `transcript.ts`'s `applyFrame` reads this to tell OMP's own unsolicited startup banner
   * apart from a user-run slash command's output (`STARTUP_NOTICE_PREFIX`): `false` only for the
   * window between this `SessionAgent`'s construction and the user's first `send()` call, which
   * is the only place in this class that represents the user actually doing something (a prompt
   * or a slash command, both go through `send`). Set once and never reset for the rest of this
   * instance's lifetime -- so a later `restart()`'s own fresh startup banner does NOT get tagged
   * (the flag is already `true` by then, from the user's earlier `send()`); only a banner arriving
   * before that very first `send()` ever gets the startup prefix. */
  private hasUserActed = false;

  // --- Spec 004: readout + subagent tracking ---------------------------------------------
  private readoutTimer: NodeJS.Timeout | undefined;
  private readoutInFlight = false;
  private readoutPending = false;
  private prPollTimer: NodeJS.Timeout | undefined;
  /** Spec 004 remediation (HIGH): the PR lookup's own cache, refreshed only by
   * `refreshPullRequest` (the poll timer, once at Session open, or a branch change noticed in
   * `computeReadout`) -- never looked up fresh per readout trigger; see that method's own doc
   * comment. `null` until the first refresh resolves, same "not read yet" meaning every other
   * readout field's `null` already carries. */
  private cachedPullRequest: SessionReadout['pullRequest'] = null;
  /** The branch `cachedPullRequest` was last computed for; a mismatch against the registry's
   * current `session.branch` is `computeReadout`'s own signal to kick off a fresh
   * `refreshPullRequest` outside the poll timer. */
  private pullRequestBranch: string | undefined;
  /** Set once the first `get_state` syncs this run (constructor/launch/settle); before that,
   * `contextUsage`/`todoProgress` stay at whatever `assembleReadout` already had rather than
   * jumping to `'not-available'` -- no reading was ever expected yet. */
  private stateSynced = false;
  private lastContextUsage: { tokens: number; contextWindow: number; percent: number } | undefined;
  private lastTodoPhases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> | undefined;
  /** One `TranscriptItem[]` stream per subagent id, built the same way the main transcript is
   * (data-model.md): requested on demand via `chat.subagentSnapshot`, patched via
   * `subagent:patch` for whichever one `setVisibleSubagent` last named. Cleared per-id when its
   * owning turn ends (next `agent_start`), alongside `runtime.subagents`. */
  private readonly subagentStreams = new Map<string, TranscriptItem[]>();
  private visibleSubagentId: string | null = null;
  private readonly subagentPatches = new PatchCoalescer((ops) => {
    if (this.visibleSubagentId === null) return;
    this.emit('subagentPatch', { sessionId: this.sessionId, subagentId: this.visibleSubagentId, ops });
  });

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
      turnStartedAt: null,
      readout: EMPTY_READOUT,
      subagents: [],
      stoppedOnRequest: false,
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

  /** `conversationSwitch.ts`'s `startStoppedSessionOnConversation` (issue #69 fix): starts a
   * `stopped` Session that is about to be pointed at a different Conversation, running `prepare`
   * (the registry write choosing that Conversation) INSIDE the same in-flight attempt `start()`
   * guards with, before `doStart()`'s `requireSession()` reads it back -- so a `start()` already
   * in flight (or a live process, or any non-`stopped` status) can never silently join this
   * attempt and reattach the OLD Conversation instead. The synchronous check below runs before
   * any `await`, so two rapid calls can never both pass it. */
  async startWith(prepare: () => Promise<void>): Promise<void> {
    if (this.startPromise || this.restartPromise || this.process || this.runtime.status !== 'stopped') {
      throw new SessionNotIdleError(`SessionAgent ${this.sessionId}: cannot start while not idle`);
    }
    this.stopRequested = false;
    this.startPromise = prepare()
      .then(() => this.doStart())
      .finally(() => {
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
    // Quality-gate fix (cycle 2, 2026-10-08): a fresh launch attempt (success or failure) always
    // ends the "the user just stopped this on purpose" window -- see `SessionRuntime.
    // stoppedOnRequest`'s own doc comment.
    this.runtime = { ...this.runtime, stoppedOnRequest: false };
    // Quality-gate fix (cycle 3, 2026-10-08): a new life starting -- see `lifeEpoch`'s own doc
    // comment.
    this.lifeEpoch += 1;
    // Quality-gate fix (cycle 4, 2026-10-08): the PERSISTED sibling of the in-memory reset above
    // -- see `Session.stoppedOnRequestConversation`'s own doc comment for why an active clear
    // here is still needed even though the marker's own size check is already passive.
    // Quality-gate fix (cycle 5, 2026-10-08): stored on `markerWrite` (not `void`-discarded) so
    // `shutdown()` can still wait for whichever marker write is currently in flight -- never
    // throws, so there is nothing for a caller to catch.
    this.markerWrite = clearStoppedOnRequestMarker(this.registry, this.sessionId);
    const approvalMode = this.settings.get().approvalMode;
    const proc = new OmpProcess({
      cwd: session.worktreePath,
      approvalMode,
      sessionId: session.id,
      ompPath: this.ompPath,
    });
    proc.on('frame', (frame: Frame) => this.onFrame(frame));
    // Quality-gate fix (cycle 3, 2026-10-08, Low): `onExit` is `async` (it awaits a tail read on
    // the crash path); an unhandled rejection from it would otherwise surface as a process-level
    // warning with no Session context.
    proc.on('exit', (info: { code: number | null; requested: boolean }) => {
      void this.onExit(info).catch((err) => console.error(`SessionAgent ${this.sessionId}: onExit threw`, err));
    });

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
    // Constitution v1.9.0 / FINDINGS item 44: computed from the PRE-launch `session` (the
    // registry's last known `lastMessageCount`) vs the freshly observed `state`, before
    // `syncFromState` re-baselines it below -- see `reattachRebaselineNotice`'s doc comment.
    const rebaselineNotice = session.currentConversation ? reattachRebaselineNotice(session, state) : undefined;
    const bail2 = await bailIfStopRequested(this.stopRequested, proc, () => {
      this.process = undefined;
      this.setStatus('stopped', { stopReason: 'not-started' });
    });
    if (bail2) return bail2;
    let transcript: TranscriptItem[] = [];
    let messagesOk = false;
    try {
      // Issue #510 slice 4 (PLAN.md row A0): several bounded `get_messages_page` round trips
      // instead of one unbounded `get_messages` -- see `fetchAllMessages.ts`'s own doc comment
      // and docs/spike/FINDINGS.md item 47. `complete` mirrors the old single-call `success`.
      const { messages, complete } = await fetchAllMessages(proc);
      if (complete) {
        // Issue #489 (durable turn marker, 2026-10-07): re-fetched fresh here, not the `session`
        // parameter captured earlier in `doStart()`, so this always reflects the latest
        // `currentTurnSubagents` even on the rare chance a prior life of this SAME instance
        // wrote to it after that snapshot was taken.
        // Issue #510 slice 3 (PLAN.md row A0): `session.currentConversation` is the SAME file
        // this reattach just verified against -- if ITS tail shows the previous life ended mid
        // tool-call, any row `fromHistory` would otherwise leave `running` forever is settled to
        // `interrupted` instead (`settleInterruptedToolRows`).
        const terminatedUnexpectedly = (await detectUnexpectedTermination(session.currentConversation)).terminatedUnexpectedly;
        transcript = fromHistory(
          messages,
          new Set(currentTurnKeys(this.registry.getSession(this.sessionId))),
          terminatedUnexpectedly,
        );
        messagesOk = true;
      } else {
        console.error(`SessionAgent ${this.sessionId}: fetchAllMessages did not complete`);
      }
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: fetchAllMessages threw`, err);
    }
    const exitedDuringStart1 = exitedDuringStart(this.process === proc, failurePrefix, (d) => this.recordStartFailure(d));
    if (exitedDuringStart1) return exitedDuringStart1;

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
    // Told once here (after the merge above so it isn't dropped as an unpersisted notice by
    // `mergeLiveTranscript`, and only on this reattach's settle, not on every later one).
    if (rebaselineNotice) this.appendNotice(rebaselineNotice);

    // Issue #489 (PLAN.md row A2c): reconcile `runtime.subagents` against any still-`running`
    // record a PREVIOUS process life left behind, on every attach/resume. Two distinct ways a
    // `running` entry can be stale by the time this runs: (a) `recover()`/a mode-change restart
    // reuses THIS SAME `SessionAgent` instance -- `runtime.subagents` is never cleared by a
    // crash (only by the next `agent_start`), so a `SubagentSummary` a live
    // `tool_execution_update` set to `running` before the old process died is still sitting
    // there untouched; (b) a true app restart builds a brand-new instance whose `subagents`
    // starts `[]` -- only the reattached transcript's own `kind: 'subagent'` row remembers it,
    // and OMP's own persisted history never records a completion for a call that crashed
    // mid-flight, so `fromHistory` (just merged into `this.runtime.transcript` above) rebuilds
    // it as `running` again on every single `get_messages`. `reconcileSubagentsOnAttach` covers
    // both, synchronously (gate finding 5: the fresh `proc` this `launch()` just spawned can
    // never have a non-empty `get_subagents` registry of its own, confirmed live even seconds
    // after a hard-killed process's genuinely-running subagent -- asking it is decorative, so
    // this no longer does).
    this.reconcileSubagentsOnAttach();
    await this.syncFromState(state);
    const exitedDuringStart2 = exitedDuringStart(this.process === proc, failurePrefix, (d) => this.recordStartFailure(d));
    if (exitedDuringStart2) return exitedDuringStart2;
    this.emitStatus();
    this.emitPatchReset();
    // Spec 004: the pull-request chip has no OMP frame to react to, so it is polled on a timer
    // once a Session has been opened (started here, never for a Session nobody opened this run).
    // Spec 004 remediation (HIGH): the timer (and this one-off open-time refresh) is now the
    // *only* place that actually calls `gh pr list` -- see `refreshPullRequest`'s own doc
    // comment for why every other readout trigger must not.
    if (!this.prPollTimer) {
      void this.refreshPullRequest();
      this.prPollTimer = setInterval(() => void this.refreshPullRequest(), PR_POLL_INTERVAL_MS);
    }
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
      await assertConversationFileExists(session.currentConversation);
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
    if (this.prPollTimer) {
      clearInterval(this.prPollTimer);
      this.prPollTimer = undefined;
    }
    // Low finding (spec 004 remediation): a debounced readout already queued by
    // `scheduleReadoutUpdate` still ran `computeReadout` (git/gh calls included) and emitted
    // after `shutdown()`, for a Session nothing is listening to any more.
    if (this.readoutTimer) {
      clearTimeout(this.readoutTimer);
      this.readoutTimer = undefined;
    }
    await stopIfRunning(this.process);
    // Quality-gate fix (HIGH, cycle 5, 2026-10-08): `stopIfRunning` resolves once the process has
    // actually exited, which is strictly AFTER `onExit`'s own synchronous body (including this
    // assignment to `markerWrite`) already ran -- `OmpProcess`'s internal exit handler resolves
    // its `exitWaiters` (what `stopIfRunning`/`proc.stop()` awaits) and emits `'exit'` (which
    // synchronously invokes `SessionAgent.onExit`) in the same synchronous turn, so `markerWrite`
    // is never stale here. Without this await, a requested stop's marker write could still be
    // in flight when `stopAll()` (`before-quit`) resolves and the app quits, losing the exact
    // guarantee cycle 4 added. Never rejects (`recordStoppedOnRequestMarker`/
    // `clearStoppedOnRequestMarker` both already catch their own errors), the extra `.catch` is
    // defence in depth only.
    await this.markerWrite.catch(() => undefined);
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
    if (!this.stopRequested && this.startPromise === undefined && this.runtime.pendingMode !== null && this.runtime.pending.length === 0 && this.runtime.status === 'idle') {
      void this.restart('approval mode change');
    }
  }

  /** `chat.send` (contracts/omp-usage.md "Send a message"): `message`, never `text`; a
   * `streamingBehavior:'followUp'` prompt while a turn is already running becomes a queue chip
   * instead of starting a second turn. `queued` reports which case this was. `images` (spec 009,
   * FR-006, FR-017) is forwarded unchanged onto the `prompt` command either way -- an idle send
   * and one that queues as a followUp both carry pending attachments the same way -- and is
   * omitted from the command entirely (never sent as `images: undefined`) when there is none,
   * matching how `streamingBehavior` itself is only set when needed. The caller (`chat.ts`) has
   * already independently re-validated every entry (FR-018); this method never re-checks them. */
  async send(text: string, images?: ImageContent[]): Promise<{ queued: boolean }> {
    // Marks the user's first real action in this process (see `hasUserActed`'s own doc comment)
    // before either guard below can throw: even a `send()` that ultimately fails to reach the
    // process is the user genuinely trying to do something, never OMP's own unprompted startup.
    this.hasUserActed = true;
    if (this.restarting) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot send, restart in progress`);
    }
    if (!this.process) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot send, no live process`);
    }
    const working = this.runtime.status === 'working' || this.runtime.status === 'needs-you';
    const imagesField = images && images.length > 0 ? { images } : {};
    const res = working
      ? await this.process.request({ type: 'prompt', id: '', message: text, ...imagesField, streamingBehavior: 'followUp' })
      : await this.process.request({ type: 'prompt', id: '', message: text, ...imagesField });
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
    await waitForIdleStatus(this, this.runtime.status, ABORT_SETTLE_TIMEOUT_MS, this.sessionId);
  }

  /** `chat.removeQueued` (issue #540): `queue` is the chip's own queue -- OMP's
   * `remove_queued_message` only matches within the exact queue given, so the old hard-coded
   * `'followUp'` made a steering chip's Remove always report `removed: false` (the message was
   * never in that queue), with no way to ever remove one. Hides the chip only when OMP reports
   * `removed: true`. Gate fix (Medium, #591 cycle 2): an RPC-level failure now throws (mirroring
   * `sendNow`'s own High fix) instead of being folded into `{ removed: false }`, which the
   * renderer otherwise read as the untruthful "already being delivered" notice regardless of the
   * real cause. */
  async removeQueued(text: string, queue: QueueKind): Promise<{ removed: boolean }> {
    if (!this.process) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot remove a queued message, no live process`);
    }
    const res = await this.process.request({ type: 'remove_queued_message', id: '', message: text, queue });
    if (!res.success) {
      this.appendNotice(`remove_queued_message failed: ${res.error ?? 'unknown error'}`, 'error');
      throw new PromptFailedError(`SessionAgent ${this.sessionId}: remove_queued_message failed: ${res.error ?? 'unknown error'}`);
    }
    return { removed: (res.data as { removed?: boolean } | undefined)?.removed === true };
  }

  /** `chat.predictWord` (T103, FR-058): ghost-text composer completion. Issues `predict_word`
   * ONLY on an already-running live `OmpProcess` -- never `start()`'s path -- since the first call
   * after a cold shared prediction daemon start can take up to ~2 minutes (rpc.md "Word
   * prediction", FINDINGS item 28), and a keystroke in a stopped Session's composer must never
   * trigger that wait. `predict_word` is best-effort, inline-editor sugar, not a user-facing
   * action: no live process, a failed RPC call, or a timeout all resolve to `null` (no
   * suggestion) rather than throwing or appending a visible notice, so a predict_word failure is
   * never surfaced as an error. */
  async predictWord(text: string, cursor: number): Promise<string | null> {
    if (!this.process) return null;
    try {
      const res = await this.process.request({ type: 'predict_word', id: '', text, cursor }, PREDICT_WORD_TIMEOUT_MS);
      if (!res.success) return null;
      const suffix = (res.data as PredictWordResponseData | undefined)?.suffix;
      return typeof suffix === 'string' ? suffix : null;
    } catch {
      return null;
    }
  }

  /** `chat.predictWordFeedback`: companion to `predictWord` above, same silent-degradation
   * contract -- no live process or a failed send is dropped, never surfaced. */
  async predictWordFeedback(text: string, cursor: number, suggestion: string, accepted: boolean): Promise<void> {
    if (!this.process) return;
    try {
      await this.process.request({ type: 'predict_word_feedback', id: '', text, cursor, suggestion, accepted });
    } catch {
      // best-effort; see predictWord's doc comment above
    }
  }

  /** `chat.sendNow` (contracts/omp-usage.md "Send now (steer)", issue #540): a single atomic
   * `promote_queued_message` call -- OMP moves the existing queued follow-up (attachments and any
   * contiguous hidden companions included) to the end of the steering queue, with no reprocessing
   * and no duplicate, replacing the old hand-made remove-then-steer (which could leave a message
   * removed from the queue but never steered if the `steer` half failed). Only ever called for a
   * follow-up chip (the renderer offers "Send now" on follow-up chips only, matching
   * `promote_queued_message`'s own semantics: it never matches a steering-queue message).
   * `promoted: false` means it was no longer pending at dispatch time (e.g. already delivered). */
  async sendNow(text: string): Promise<{ promoted: boolean }> {
    if (!this.process) {
      throw new AgentNotRunningError(`SessionAgent ${this.sessionId}: cannot send now, no live process`);
    }
    const res = await this.process.request({ type: 'promote_queued_message', id: '', message: text });
    if (!res.success) {
      // Gate fix (High, #591): an RPC-level failure here is NOT the legitimate "already
      // delivered" case below -- it must surface as `!result.ok` so the renderer's `notify`
      // path fires a visible toast, instead of being folded into `{ promoted: false }` (which
      // the renderer reads as the message simply having left the queue already).
      this.appendNotice(`promote_queued_message failed: ${res.error ?? 'unknown error'}`, 'error');
      throw new PromptFailedError(`SessionAgent ${this.sessionId}: promote_queued_message failed: ${res.error ?? 'unknown error'}`);
    }
    const promoted = (res.data as { promoted?: boolean } | undefined)?.promoted === true;
    return { promoted };
  }

  /** `conversations.startNew` (contracts/omp-usage.md "New Conversation"): same process, same
   * cwd, same Session; clears the transcript. No Conversation is current until the first message
   * of the new one is written (OMP creates the file lazily), so `currentConversation` is cleared
   * to `null` here; `syncFromState` leaves it `null` too (below, run immediately after
   * `new_session` -- issue #577 -- since `messageCount` is still 0) until the first message is
   * sent, at the next settle. */
  async startNewConversation(): Promise<void> {
    if (this.runtime.status !== 'idle' || !this.process) {
      throw new SessionNotIdleError(`SessionAgent ${this.sessionId}: cannot start a new Conversation while ${this.runtime.status}`);
    }
    // Issue #592: captured once, up front, so a concurrent `onExit` (which sets `this.process`
    // to `undefined`) cannot pull the process out from under the later `get_state` call below --
    // every request in this method goes through this same reference, never `this.process` again.
    const proc = this.process;
    const res = await proc.request({ type: 'new_session', id: '' });
    if (!res.success) {
      throw new Error(`SessionAgent ${this.sessionId}: new_session failed: ${res.error ?? 'unknown error'}`);
    }
    try {
      await this.registry.updateSession(this.sessionId, { currentConversation: null, lastMessageCount: null });
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: failed to clear currentConversation after new_session`, err);
    }
    // Issue #577: the Context/Todo/Subagents chips otherwise kept the OLD conversation's reading
    // until the next turn settled -- nothing here ever re-ran `syncFromState` (the only place
    // that writes `lastContextUsage`/`lastTodoPhases`), and `runtime.subagents` is normally
    // cleared only by the next `agent_start`. Cleared first, unconditionally, so a `get_state`
    // failure below can never leave a stale reading on screen instead of the new conversation's
    // baseline (which `new_session` guarantees is a brand-new, empty history: no leftover
    // `kind: 'subagent'` transcript rows to reconcile from, unlike `openConversation`'s switch to
    // a DIFFERENT, possibly non-empty past Conversation).
    this.lastContextUsage = undefined;
    this.lastTodoPhases = undefined;
    // Issue #592: shares `agent_start`'s own subagent-state reset via `resetTurnSubagentState`
    // (see its doc comment) -- without it, the PRIOR conversation's subagent streams and
    // selected-subagent id survive in memory and can still emit stale `subagent:patch` updates
    // for a conversation that no longer exists.
    this.resetTurnSubagentState('after new_session');
    this.runtime = { ...this.runtime, transcript: [], subagents: [] };
    this.emit('subagents', { sessionId: this.sessionId, subagents: this.runtime.subagents });
    this.emitPatchReset();
    // Issue #592: `new_session` already succeeded above, so this method must resolve normally
    // even if this refresh fails -- a `get_state` rejection (OmpProcess times out or the process
    // exits mid-request) must not surface as an uncaught rejection reporting the whole call as
    // failed. Matches `onSessionSettled`'s own try/catch around the same get_state+syncFromState
    // pair.
    try {
      const stateRes = await proc.request({ type: 'get_state', id: '' });
      if (stateRes.success) {
        await this.syncFromState(stateRes.data as GetStateResponseData);
      } else {
        console.error(`SessionAgent ${this.sessionId}: get_state after new_session failed: ${stateRes.error ?? 'unknown error'}`);
        this.scheduleReadoutUpdate();
      }
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: get_state after new_session threw`, err);
      this.scheduleReadoutUpdate();
    }
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
    // Issue #510 slice 4 (PLAN.md row A0): see `fetchAllMessages.ts`'s own doc comment and
    // docs/spike/FINDINGS.md item 47.
    const { messages, complete } = await fetchAllMessages(this.process);
    const currentTurnKeySet = new Set(currentTurnKeys(this.registry.getSession(this.sessionId)));
    // Issue #510 slice 3 (PLAN.md row A0): `file` is the historical Conversation just switched
    // to -- if ITS tail shows it was abandoned mid tool-call, that row is settled to
    // `interrupted` rather than left spinning `running` forever once rendered as history.
    const terminatedUnexpectedly = (await detectUnexpectedTermination(file)).terminatedUnexpectedly;
    const transcript = complete ? fromHistory(messages, currentTurnKeySet, terminatedUnexpectedly) : [];
    // Gate fixes 2 finding 4: reconcile here too, same rule as `launch()` -- without it a
    // Conversation whose last turn crashed mid-subagent opens with a row stuck on 'running'
    // forever. A different Conversation has an entirely different subagent history, and nothing
    // else clears `runtime.subagents` on a plain Conversation switch (only the next
    // `agent_start` does), so it is reset to `[]` first: this reconciles purely from the fresh
    // `transcript` just fetched above, same as a true app restart, never carrying a PREVIOUS
    // Conversation's entries into this one.
    this.runtime = { ...this.runtime, transcript, subagents: [] };
    this.reconcileSubagentsOnAttach();
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
    await recoverFromFailedSwitch(
      {
        process: this.process,
        sessionId: this.sessionId,
        requireSession: () => this.requireSession(),
        applyTranscript: (transcript) => {
          this.runtime = { ...this.runtime, transcript };
          this.emitPatchReset();
        },
        onUnrecoverable: (detail) => {
          this.process = undefined;
          this.recordStartFailure(detail);
        },
      },
      previousConversation,
      attemptedFile,
      reason,
    );
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
    // Issue #592 (Low): the session can vanish mid-call (deleted while this `await` was in
    // flight) -- nothing to sync, but `scheduleReadoutUpdate` is still called for consistency
    // with every other guard clause in this method; `computeReadout` already re-checks
    // `registry.getSession` itself and no-ops the same way, so this is never more than a wasted
    // timer tick.
    if (!session) {
      this.scheduleReadoutUpdate();
      return;
    }
    const patch: Partial<Session> = { lastActivityAt: new Date().toISOString() };
    if (session.sessionDir === null) {
      patch.sessionDir = path.dirname(state.sessionFile);
    }
    if (state.messageCount > 0) {
      patch.lastMessageCount = state.messageCount;
      patch.currentConversation = state.sessionFile;
    }
    // T062/FINDINGS item 30: persisted (registry-backed) last-known model/thinking level, not
    // only live-runtime state -- never cleared when the agent stops, so Stop and an app restart
    // both keep showing the last values `get_state` actually reported. Written as one atomic
    // patch from the same `get_state` snapshot: if `state.model` is present, `lastThinkingLevel`
    // is set alongside it (even to `undefined`, for a non-reasoning model) so a new model can
    // never end up paired with a stale effort value left over from a previous model.
    // Security audit finding (2026-10-03, Medium): `state.model`/`state.thinkingLevel` are OMP's
    // own output, untyped at the IPC boundary beyond a cast -- a malformed value (non-string
    // field, or a string shaped to collide with Object.prototype when used as a lookup key
    // elsewhere) used to be stored as-is, persisting a value that could crash the renderer on
    // every later read, surviving a restart since `syncFromState` never re-validates stored data.
    // `isValidModelRef`/a length cap below reject a malformed snapshot entirely (keeping the
    // prior good value, never storing a maybe-garbage one) rather than storing it and hoping a
    // later `get_state` repairs it.
    if (state.model && isValidModelRef(state.model)) {
      patch.lastModel = {
        provider: state.model.provider.slice(0, MAX_MODEL_FIELD_LENGTH),
        id: state.model.id.slice(0, MAX_MODEL_FIELD_LENGTH),
        name: state.model.name?.slice(0, MAX_MODEL_FIELD_LENGTH),
      };
      patch.lastThinkingLevel =
        typeof state.thinkingLevel === 'string'
          ? state.thinkingLevel.slice(0, MAX_MODEL_FIELD_LENGTH)
          : undefined;
    }
    try {
      await this.registry.updateSession(this.sessionId, patch);
      this.emit('registryUpdated', { sessionId: this.sessionId });
    } catch (err) {
      console.error(`SessionAgent ${this.sessionId}: failed to update registry from get_state`, err);
    }
    // Spec 004 FR-003/FR-021, FINDINGS items 34/35: `get_state` is the only source for both the
    // Context window usage and Todo progress chips; captured here so `assembleReadout` never
    // needs its own `get_state` round trip.
    this.stateSynced = true;
    this.lastContextUsage = state.contextUsage;
    this.lastTodoPhases = state.todoPhases;
    this.scheduleReadoutUpdate();
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
    // Spec 004 data-model.md: turnTime/subagentCount are always null outside a running turn.
    this.runtime = { ...this.runtime, turnStartedAt: null };
    this.scheduleReadoutUpdate();
    void this.onSessionSettled().then(() => this.maybeRestartForPendingMode());
  }

  private async onExit(info: { code: number | null; requested: boolean }): Promise<void> {
    this.process = undefined;
    this.finalizeLiveItems();
    if (this.restarting && info.requested) return; // restart() owns this transition; see its doc comment.
    this.settleTurnPendingRequests('Request withdrawn: the agent process exited.');
    if (this.runtime.turnStartedAt !== null) {
      this.runtime = { ...this.runtime, turnStartedAt: null };
      this.scheduleReadoutUpdate();
    }
    if (info.requested) {
      // A requested stop is never "unexpected" by definition, regardless of what the
      // Conversation's own tail happens to show (quality gate 2026-10-08). Quality-gate fix
      // (cycle 2): stored on `this.runtime` too (not just sent on this one live event), so
      // every later reader that would otherwise re-derive this from the tail (`summaries()`,
      // `buildSnapshot`) sees it as well -- see `SessionRuntime.stoppedOnRequest`'s own doc
      // comment.
      this.runtime = { ...this.runtime, stoppedOnRequest: true };
      // Quality-gate fix (cycle 4, 2026-10-08): the PERSISTED sibling of the in-memory flag
      // above -- see `Session.stoppedOnRequestConversation`'s own doc comment. Quality-gate fix
      // (cycle 5, 2026-10-08): stored on `markerWrite` (not `void`-discarded) so `shutdown()`
      // can wait for it (never throws, so there is nothing for a caller to catch); `epochAtExit`
      // captured here, BEFORE the write's own internal `fs.stat` await, and re-checked after it
      // (`stillCurrent`) closes the race with a `launch()` that starts a brand new life while
      // this write is still in flight -- see `recordStoppedOnRequestMarker`'s own doc comment.
      const epochAtExit = this.lifeEpoch;
      this.markerWrite = recordStoppedOnRequestMarker(
        this.registry,
        this.sessionId,
        this.registry.getSession(this.sessionId)?.currentConversation ?? null,
        () => this.lifeEpoch === epochAtExit,
      );
      this.setStatus('stopped', { stopReason: 'not-started', terminatedUnexpectedly: false });
      return;
    }
    // Quality-gate fix (cycle 2): explicit, not just "already false by default" -- a crash is
    // definitionally NOT a requested stop, so this life's own flag must never read stale `true`
    // from however this Session got here.
    this.runtime = { ...this.runtime, stoppedOnRequest: false };
    // Quality-gate fix (cycle 3, 2026-10-08): captured BEFORE the tail-read await below, which a
    // concurrent `launch()` attempt for the SAME exit can easily outrun (its own handshake/attach
    // failure handling runs synchronously, no file read involved) -- without this guard, this
    // branch used to unconditionally overwrite whatever `launch()`'s own `recordStartFailure`
    // (or a `bailIfStopRequested` bail) had ALREADY recorded with the generic 'agent-exited',
    // losing the specific reason (start-failed, its stderr detail, worktree-missing, not-started)
    // and, through #585's `canResumeSession`, wrongly offering Resume instead of #449's own
    // Retry/Start-new actions on a start failure.
    const epochAtExit = this.lifeEpoch;
    const currentConversation = this.registry.getSession(this.sessionId)?.currentConversation ?? null;
    const terminatedUnexpectedly = (await detectUnexpectedTermination(currentConversation)).terminatedUnexpectedly;
    if (!shouldApplyCrashExitVerdict(this.runtime.status, this.lifeEpoch, epochAtExit)) return;
    this.setStatus('stopped', {
      stopReason: 'agent-exited',
      stopDetail: `exit code ${String(info.code)}`,
      terminatedUnexpectedly,
    });
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
        // Spec 004 remediation (HIGH) / Issue #489: shares `startNewConversation`'s
        // subagent-state reset via `resetTurnSubagentState` -- see its doc comment for why each
        // field (streams, selection, patches, and the persisted `currentTurnSubagents` twin) is
        // cleared on every new turn, not just this one.
        this.resetTurnSubagentState('on agent_start');
        this.runtime = { ...this.runtime, turnStartedAt: Date.now(), subagents: [] };
        this.emit('subagents', { sessionId: this.sessionId, subagents: this.runtime.subagents });
        this.scheduleReadoutUpdate();
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
        // T093 (FR-032): only the fixed supported set (plus Refract's built native
        // commands) is ever kept, so the menu and chat.send's validation both stay in sync
        // through this one list -- a command OMP added since the last probe stays hidden.
        const commandsFrame = frame as AvailableCommandsUpdateFrame;
        this.commands = filterSupportedCommands(commandsFrame.commands);
        this.emit('commands', { sessionId: this.sessionId, commands: this.commands });
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
      case 'command_output':
      case 'notice':
        this.applyTranscriptFrame(frame);
        return;
      case 'tool_execution_start': {
        this.applyTranscriptFrame(frame);
        const startFrame = frame as ToolExecutionStartFrame;
        if (startFrame.toolName === 'task') this.handleTaskStart(startFrame);
        else this.scheduleReadoutUpdate(); // spec 004 FR-002: a non-task tool call may change Changes
        return;
      }
      case 'tool_execution_end': {
        this.applyTranscriptFrame(frame);
        const endFrame = frame as ToolExecutionEndFrame;
        if (endFrame.toolName === 'task') this.handleTaskEnd(endFrame);
        this.scheduleReadoutUpdate();
        return;
      }
      case 'tool_execution_update': {
        const updateFrame = frame as ToolExecutionUpdateFrame;
        if (updateFrame.toolName === 'task') this.handleTaskUpdate(updateFrame);
        return;
      }
      default: {
        // agent_end (Refract tracks history incrementally, not from the final snapshot),
        // rpc_chunk/response (consumed inside OmpProcess and never emitted as 'frame'), and
        // most unrecognised frame types: no-op. T079/FINDINGS item 22(f): if OMP sends a
        // subagent-to-parent IRC message as its own top-level frame instead of a `custom`
        // message (the hypothesis `transcript.ts`'s message-lifecycle path already covers),
        // shape-detect it here so it is never silently dropped.
        const agentMessage = tryBuildAgentMessageFromUnknownFrame(frame, this.runtime.transcript.length);
        if (agentMessage) this.upsertTranscriptItem(agentMessage);
        return;
      }
    }
  }

  private applyTranscriptFrame(frame: Frame): void {
    const next = applyFrame(this.runtime.transcript, frame, this.hasUserActed);
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
   * no Refract window is focused, becomes `unread`; cleared by `clearUnread()` when it becomes
   * visible. */
  private setStatus(
    status: SessionStatus,
    extra?: { stopReason?: SessionRuntime['stopReason']; stopDetail?: string; terminatedUnexpectedly?: boolean },
  ): void {
    const becameUnread = this.runtime.status === 'working' && status === 'idle' && (!this.isVisible() || !this.isWindowFocused());
    this.runtime = {
      ...this.runtime,
      status,
      stopReason: extra?.stopReason,
      stopDetail: extra?.stopDetail,
      unread: becameUnread ? true : this.runtime.unread,
    };
    this.emitStatus(extra?.terminatedUnexpectedly);
  }

  /** Clears `unread` once this Session becomes the visible one (T037); a no-op if already clear. */
  clearUnread(): void {
    if (!this.runtime.unread) return;
    this.runtime = { ...this.runtime, unread: false };
    this.emitStatus();
  }

  /** Issue #510 (quality gate 2026-10-08): `terminatedUnexpectedly` is passed through from the
   * caller (only `setStatus`'s transition to `stopped` ever supplies it, computed live in
   * `onExit`) rather than stored on `this.runtime` -- every other reader of the Session's
   * termination state (`sessions.list`, `buildSnapshot`) re-derives it fresh from the
   * Conversation file itself, so this event-only value never needs to be a lasting source of
   * truth. */
  private emitStatus(terminatedUnexpectedly?: boolean): void {
    const payload: SessionStatusEvent = {
      sessionId: this.sessionId,
      status: this.runtime.status,
      stopReason: this.runtime.stopReason,
      stopDetail: this.runtime.stopDetail,
      terminatedUnexpectedly,
      unread: this.runtime.unread,
      launchedMode: this.runtime.launchedMode,
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

  /**
   * Issue #592: the subagent-state clears shared by `agent_start` (every new turn) and
   * `startNewConversation` (Issue #577: a reset with no turn of its own) -- both need the exact
   * same four clears so the PRIOR turn/conversation's subagent state can never survive to be
   * read, or forwarded to, the next one:
   * - `subagentStreams`/`visibleSubagentId`/`subagentPatches` (Spec 004 remediation, HIGH): the
   *   previous turn's selected-subagent id and any patches still coalescing for it are stale the
   *   instant a new turn (or a brand-new Conversation) starts -- the renderer's own panel does
   *   the matching reset of its selection/stream cache on this same signal (readout-store.ts's
   *   `applySubagents`), so main must stop forwarding/queuing for an id no later
   *   `tool_execution_update` will ever match again (ids are per-toolCallId, never reused)
   *   rather than just letting it quietly go dead.
   * - `Session.currentTurnSubagents` (Issue #489, durable turn marker, 2026-10-07): the
   *   persisted twin of `runtime.subagents`, cleared at the exact same trigger so the two can
   *   never disagree about what counts as "this turn". Skipped when already empty, so a turn
   *   with no subagents at all -- the common case -- never costs a registry write.
   *
   * Does NOT touch `runtime.subagents` itself or emit the `'subagents'` event: those are part of
   * each caller's own `runtime` reassignment (which also sets a sibling field -- `turnStartedAt`
   * vs. `transcript` -- that differs per call site), and both callers already emit identically
   * right after calling this. `reason` is folded into this method's own error log only, to tell
   * the two call sites apart if the registry write ever fails.
   */
  private resetTurnSubagentState(reason: string): void {
    this.subagentStreams.clear();
    this.visibleSubagentId = null;
    this.subagentPatches.clear();
    const currentSession = this.registry.getSession(this.sessionId);
    if (currentSession && currentTurnKeys(currentSession).length > 0) {
      this.registry.updateSession(this.sessionId, { currentTurnSubagents: [] }).catch((err) => {
        console.error(`SessionAgent ${this.sessionId}: failed to clear currentTurnSubagents ${reason}`, err);
      });
    }
  }

  // --- Spec 004: readout assembly ---------------------------------------------------------

  /** Debounced to `READOUT_COALESCE_MS`, then single-flight (a trigger arriving while a
   * computation is already in progress joins the next run instead of starting a second
   * overlapping one), matching `transcript:patch`'s own coalescing discipline. */
  private scheduleReadoutUpdate(): void {
    if (this.readoutTimer) return;
    this.readoutTimer = setTimeout(() => {
      this.readoutTimer = undefined;
      this.runReadoutUpdate();
    }, READOUT_COALESCE_MS);
  }

  private runReadoutUpdate(): void {
    if (this.readoutInFlight) {
      this.readoutPending = true;
      return;
    }
    this.readoutInFlight = true;
    // Low finding (spec 004 remediation): neither `computeReadout` nor this `.finally` ever had
    // a `.catch` -- a rejection (a future `assembleReadout`/`diffStat` regression) was an
    // unhandled promise rejection instead of a logged, contained failure.
    void this.computeReadout()
      .catch((err) => console.error(`SessionAgent ${this.sessionId}: computeReadout failed`, err))
      .finally(() => {
        this.readoutInFlight = false;
        if (this.readoutPending) {
          this.readoutPending = false;
          this.runReadoutUpdate();
        }
      });
  }

  private async computeReadout(): Promise<void> {
    const session = this.registry.getSession(this.sessionId);
    if (!session) return;
    // Spec 004 remediation (HIGH): a genuine branch change is the one non-timer, non-open
    // trigger that still deserves a fresh `gh pr list` -- every *other* readout trigger below
    // (a tool call ending, a turn starting/ending, a get_state sync) must only ever read
    // `cachedPullRequest`, never look up fresh; see `refreshPullRequest`'s own doc comment.
    if (session.branch !== this.pullRequestBranch) void this.refreshPullRequest();
    const state: ReadoutState = {
      turnStartedAt: this.runtime.turnStartedAt,
      subagents: this.runtime.subagents,
      contextUsage: this.lastContextUsage,
      stateSynced: this.stateSynced,
      todoPhases: this.lastTodoPhases,
      pullRequest: this.cachedPullRequest,
    };
    const readout = await assembleReadout(session, this.runtime.readout, state);
    this.runtime = { ...this.runtime, readout };
    this.emit('readout', { sessionId: this.sessionId, readout });
  }

  /** Spec 004 FR-006 remediation (HIGH, code-reviewer): the *only* place that actually calls
   * `gh pr list` over the network. Before this fix, `assembleReadout` looked the PR up fresh on
   * every readout trigger -- which includes every `tool_execution_update` during a streaming
   * subagent turn -- hammering Stuart's own GitHub API rate limit on a long subagent-heavy turn
   * instead of only on the intended `PR_POLL_INTERVAL_MS` timer. Runs only from: the
   * `prPollTimer` tick (`launch()`), once when a Session is opened (`launch()`, same call site,
   * before the timer's own first tick), and a genuine `session.branch` change noticed by
   * `computeReadout`. Every other trigger reads `cachedPullRequest` instead. Sets
   * `pullRequestBranch` before awaiting the lookup (not after), so a `computeReadout` branch
   * check racing the same tick never fires a redundant second lookup for the branch already
   * in flight. */
  private async refreshPullRequest(): Promise<void> {
    const session = this.registry.getSession(this.sessionId);
    if (!session) return;
    const requestedBranch = session.branch;
    this.pullRequestBranch = requestedBranch;
    const lookup = await pullRequestForBranch(session.worktreePath, requestedBranch);
    // Medium remediation (code-reviewer, spec 004 final confirmation pass): the 60s timer tick
    // and a branch-change-triggered lookup (`computeReadout`, above) can race -- if an OLDER
    // lookup (started for a branch the Session has since moved on from) resolves AFTER a NEWER
    // one already started for the branch it is really on now, applying the older result would
    // clobber `cachedPullRequest` with the wrong branch's PR, uncorrected until the next tick.
    // `pullRequestBranch` always holds the latest REQUESTED branch (set synchronously above, by
    // every call), so if it no longer matches what THIS call requested, a later call has already
    // superseded it -- this result is stale and is discarded outright rather than applied.
    if (this.pullRequestBranch !== requestedBranch) return;
    // Low remediation (code-reviewer): `shutdown()` already clears `readoutTimer` and sets
    // `stopRequested` before awaiting any in-flight work drains; without this guard, an await
    // above resolving after `shutdown()` ran would still call `scheduleReadoutUpdate()` below,
    // arming a brand-new timer post-shutdown and eventually emitting a readout for a closed
    // Session nothing is listening to any more.
    if (this.stopRequested) return;
    // Judgment call (data-model.md's retention rule vs spec.md's edge-case wording, both
    // ambiguous together): a clean lookup that finds no open PR for this branch (a PR
    // closed/merged, or a branch that never had one) actively hides the chip (quickstart Story 1
    // point 6, "Switch to a branch with no pull request... the chip disappears"); only a
    // genuinely indeterminate lookup (gh missing, offline, rate limited, no recognisable remote)
    // retains the previous reading, per data-model.md's "a lookup momentarily fails" wording.
    this.cachedPullRequest =
      lookup.status === 'found' ? lookup.pr : lookup.status === 'none' ? null : this.cachedPullRequest;
    this.scheduleReadoutUpdate();
  }

  // --- Spec 004: subagent tracking (FR-007, FR-017 to FR-020) -----------------------------

  /** `args.tasks[]` entries, read the same defensive way `transcript.ts`'s `readTaskSpecs`
   * already does for the existing collapsed chat line (not duplicated here, just mirrored). */
  private readTaskSpecs(args: unknown): Array<{ name?: string; task?: string }> {
    if (typeof args !== 'object' || args === null) return [];
    const tasks = (args as Record<string, unknown>).tasks;
    if (!Array.isArray(tasks)) return [];
    return tasks.filter((t): t is { name?: string; task?: string } => typeof t === 'object' && t !== null);
  }

  private subagentNameOrTask(spec: { name?: string; task?: string }): string {
    if (spec.name) return spec.name;
    const task = spec.task ?? '';
    return task.length > 60 ? `${task.slice(0, 60)}...` : task || 'Subagent';
  }

  /** `tool_execution_start` for the `task` tool: creates one `SubagentSummary` per spec. `id` is
   * `${toolCallId}:${name-or-fallback}` (spec 004 remediation, HIGH) -- prefixing with the
   * owning call's own `toolCallId` keeps it globally unique across both a turn with 2+ parallel
   * `task` calls and a repeated subagent name reused in a later turn, neither of which a bare
   * name (FINDINGS item 36: OMP's own `progress[].id` echoes it back unchanged) can tell apart
   * on its own; `toolCallId` is also kept as its own field so `handleTaskUpdate`/`handleTaskEnd`
   * can scope their own correlation to the right batch before ever falling back to name/position.
   * Medium remediation (code-reviewer, spec 004 final confirmation pass): that prefix alone still
   * collides when the SAME `task()` call's own `tasks[]` has two specs sharing a name (or two
   * unnamed specs whose `subagentNameOrTask` fallback happens to coincide) -- counts each spec's
   * base id's occurrences within this one batch first and appends `:${occurrence}` to every
   * duplicate (the same `${id}:${index}` disambiguation contracts/omp-usage.md already documents
   * OMP's own `progress.id` falling back to in the same circumstance), so two same-named subagents
   * never share a stream entry or a React key. `handleTaskUpdate`'s own id-match-then-position
   * fallback (below) already resolves these disambiguated slots by position once id-matching can
   * no longer succeed for them, with no further change needed there. */
  private handleTaskStart(frame: ToolExecutionStartFrame): void {
    const specs = this.readTaskSpecs(frame.args);
    if (specs.length === 0) return;
    const startedAt = Date.now();
    const baseIds = specs.map((spec) => `${frame.toolCallId}:${spec.name ?? this.subagentNameOrTask(spec)}`);
    const baseIdCounts = new Map<string, number>();
    for (const baseId of baseIds) baseIdCounts.set(baseId, (baseIdCounts.get(baseId) ?? 0) + 1);
    const occurrenceIndex = new Map<string, number>();
    const created: SubagentSummary[] = specs.map((spec, index) => {
      const baseId = baseIds[index] as string;
      const occurrence = occurrenceIndex.get(baseId) ?? 0;
      occurrenceIndex.set(baseId, occurrence + 1);
      const id = (baseIdCounts.get(baseId) ?? 0) > 1 ? `${baseId}:${occurrence}` : baseId;
      return {
        id,
        toolCallId: frame.toolCallId,
        specIndex: index,
        nameOrTask: this.subagentNameOrTask(spec),
        status: 'running',
        startedAt,
      };
    });
    for (const summary of created) {
      if (!this.subagentStreams.has(summary.id)) this.subagentStreams.set(summary.id, []);
    }
    this.runtime = { ...this.runtime, subagents: [...this.runtime.subagents, ...created] };
    this.emit('subagents', { sessionId: this.sessionId, subagents: this.runtime.subagents });
    this.scheduleReadoutUpdate();
    // Issue #489 (durable turn marker, 2026-10-07): persists this batch's `toolCallId:specIndex`
    // keys into `Session.currentTurnSubagents` the instant the call starts, so
    // `reconcileSubagentsOnAttach`/`settleStaleSubagentRows` can later scope "this turn" by
    // durable identity instead of transcript position. One write for the WHOLE batch (every spec
    // in this one `task()` call), never one write per spec, so a parallel batch costs exactly one
    // registry write regardless of how many subagents it starts. The write is queued
    // immediately (not awaited -- the `task` call is dispatched inside omp before Refract's
    // `handleTaskStart` even sees this frame, so there is nothing useful to await) onto
    // `atomicJson.ts`'s per-file atomic write queue, which lands it within milliseconds and
    // serialises it against the `agent_start` clear and any later batch's own append, so write
    // order is still guaranteed. It survives an omp process crash, a Refract restart, and a
    // normal shutdown; it can be lost only if the Electron main process itself dies in the
    // narrow window between this frame and the atomic rename, or the write itself fails
    // (logged below) -- either way the Session degrades to the pre-marker behaviour: the stale
    // `running` row is later settled to `exited` with no pill, same as before this feature.
    const session = this.registry.getSession(this.sessionId);
    if (session) {
      const newKeys = created.map((c) => `${c.toolCallId}:${c.specIndex}`);
      const nextKeys = [...new Set([...currentTurnKeys(session), ...newKeys])];
      this.registry.updateSession(this.sessionId, { currentTurnSubagents: nextKeys }).catch((err) => {
        console.error(`SessionAgent ${this.sessionId}: failed to persist currentTurnSubagents on task start`, err);
      });
    }
  }

  /** `tool_execution_update` for the `task` tool (FINDINGS item 36, spec 004 remediation HIGH):
   * scoped first to only the `SubagentSummary` entries whose own `toolCallId` matches this
   * frame's -- a turn with 2+ parallel `task` calls must never let one call's progress entries
   * match another's subagents, which a global (whole-turn) id-or-position search used to allow.
   * Within that one batch, each `progress[]` entry correlates by `id` first (`progress.id` is
   * the bare, un-prefixed name OMP echoes back), falling back to position *within the batch*
   * when no id match is found (an unnamed subagent whose fallback id never matched OMP's own
   * choice) -- never silently drops an entry, and never reaches into a different call's batch
   * to do it. Updates status/duration and patches that subagent's own stream from
   * `recentTools`/`recentOutput`. */
  private handleTaskUpdate(frame: ToolExecutionUpdateFrame): void {
    const progressList = frame.partialResult.details.progress;
    if (!Array.isArray(progressList) || progressList.length === 0) return;
    let subagents = this.runtime.subagents;
    let changed = false;
    const batchIndices: number[] = [];
    for (let i = 0; i < subagents.length; i++) {
      if (subagents[i]?.toolCallId === frame.toolCallId) batchIndices.push(i);
    }
    if (batchIndices.length === 0) return;
    for (let i = 0; i < progressList.length; i++) {
      const progress = progressList[i];
      if (!progress) continue;
      const compositeId = `${frame.toolCallId}:${progress.id}`;
      const matchIndex = batchIndices.find((idx) => subagents[idx]?.id === compositeId);
      const targetIndex = matchIndex !== undefined ? matchIndex : i < batchIndices.length ? batchIndices[i] : undefined;
      if (targetIndex === undefined) continue;
      const existing = subagents[targetIndex];
      if (!existing) continue;
      const status = progress.status === 'completed' ? 'finished' : /failed|cancelled|error/i.test(progress.status) ? 'failed' : 'running';
      const durationMs = typeof progress.durationMs === 'number' && progress.durationMs > 0 ? progress.durationMs : existing.durationMs;
      if (existing.status !== status || existing.durationMs !== durationMs) {
        subagents = subagents.map((s, idx) => (idx === targetIndex ? { ...s, status, durationMs } : s));
        changed = true;
      }
      const streamId = existing.id;
      const currentStream = this.subagentStreams.get(streamId) ?? [];
      const nextStream = applySubagentProgress(currentStream, streamId, progress);
      if (nextStream !== currentStream) {
        this.subagentStreams.set(streamId, nextStream);
        if (streamId === this.visibleSubagentId) {
          this.subagentPatches.queue(diffTranscript(currentStream, nextStream));
        }
      }
    }
    if (changed) {
      this.runtime = { ...this.runtime, subagents };
      this.emit('subagents', { sessionId: this.sessionId, subagents: this.runtime.subagents });
    }
    this.scheduleReadoutUpdate();
  }

  /** `tool_execution_end` for the `task` tool: a safety net in case a final `completed`/`failed`
   * `tool_execution_update` was somehow missed -- marks every still-`running` subagent *from
   * this call's own batch* (spec 004 remediation, HIGH: scoped by `toolCallId`, never every
   * still-running subagent across the whole turn, which used to mark a different call's own
   * still-in-progress batch finished/failed too when a turn had 2+ parallel `task` calls)
   * `finished` (or `failed` when the whole call errored), per FR-007's own wording. */
  private handleTaskEnd(frame: ToolExecutionEndFrame): void {
    const fallbackStatus: SubagentSummary['status'] = frame.isError ? 'failed' : 'finished';
    let changed = false;
    const subagents = this.runtime.subagents.map((s) => {
      if (s.toolCallId !== frame.toolCallId || s.status !== 'running') return s;
      changed = true;
      return { ...s, status: fallbackStatus, durationMs: s.durationMs ?? Date.now() - s.startedAt };
    });
    if (changed) {
      this.runtime = { ...this.runtime, subagents };
      this.emit('subagents', { sessionId: this.sessionId, subagents: this.runtime.subagents });
    }
    this.scheduleReadoutUpdate();
  }

  /**
   * Issue #489 (PLAN.md row A2c; gate fixes 2, 2026-10-07, findings 1/2/3/4/5/6/8): called from
   * every `launch()` and `openConversation()`, synchronously, to settle any subagent the
   * reattached transcript still remembers from before this process existed, and to seed this
   * turn's finished/failed subagents too (FR-007/FR-017: "the current turn's subagents", not
   * only the still-running ones). `launch()` always spawns a brand-new `OmpProcess` (never
   * reuses one), so that fresh process's own `get_subagents` registry is unconditionally empty
   * -- confirmed live even seconds after a hard-killed process's own genuinely-running subagent,
   * same Conversation file (`docs/spike/get-subagents-probe.mjs`, 2026-10-07, omp 18.8.0) -- so
   * asking it here can never discriminate "genuinely still running" from "gone": every
   * surviving `running` candidate below is unconditionally resolved straight to `'exited'`, with
   * no RPC call and no `await` at all (gate finding 5; this also makes gate finding 6's
   * post-await race structurally impossible, not just guarded -- there is no longer an await in
   * this method for `this.process`/`stopRequested` to change under). Open question 9 (PLAN.md)
   * stays open and honestly worded: this process lifecycle has no live case where asking would
   * ever answer differently.
   *
   * Two distinct sources can each hold a stale `running` record for the SAME subagent instance,
   * and must collapse to exactly ONE candidate, never two (issue #489's "2 finished" bug, gate
   * finding 1): (a) `runtime.subagents` itself, never cleared by a crash (only the next
   * `agent_start` does that) -- a `recover()`/mode-change restart reuses this SAME `SessionAgent`
   * instance, so a `SubagentSummary` a live `tool_execution_update` left at `running` is still
   * sitting there; (b) the just-merged `runtime.transcript`'s own `kind: 'subagent'` rows, which
   * `fromHistory` rebuilds as `running` from OMP's own persisted `.jsonl` on every single
   * `get_messages` call -- OMP never records a completion event for a call that crashed
   * mid-flight, so this is permanent at the data layer, not a one-off `mergeLiveTranscript`
   * could paper over. The two sides' own `id` strings use unrelated schemes
   * (`<toolCallId>:<nameOrTask>` vs `subagent:<toolCallId>:<specIndex>`) and must never be
   * compared directly; both are instead correlated by `toolCallId`+`specIndex` -- the one value
   * both derive from the SAME source `tasks[]` array, in the SAME order.
   *
   * Gate fixes 2 finding 1 (repeat-launch double count): collapsing by `toolCallId`+`specIndex`
   * on the way IN is not enough on its own -- a SECOND reconcile on the SAME instance with no new
   * turn in between (Recover twice, or Recover then a mode-change restart) must also never treat
   * an already-settled key as a brand-new candidate. `settledKeys` below records every
   * `runtime.subagents` key regardless of status (not only `running`), so a transcript row
   * `fromHistory` keeps rebuilding as `running` for a key this method already resolved is skipped
   * outright rather than minted as a second summary under a different id scheme; the merge back
   * into `runtime.subagents` likewise replaces by that SAME key, never by comparing the two id
   * schemes directly.
   *
   * Durable turn marker (2026-10-07, PLAN.md row A2c, supersedes gate fixes 3's transcript-
   * position heuristic below): the scope is no longer anchored on the transcript's own last
   * `kind: 'user'` item at all -- that plain rule (and its "last `subagent` row's preceding
   * `user` item" predecessor, gate fixes 2's attempt to dodge the steer case) each made an
   * EARLIER turn's already-finished subagents resurface as "this turn's" subagents after a
   * restart/Recover whenever a later plain turn had no `subagent` row of its own, OR (the plain
   * rule's own failure, issue #489's root cause) silently dropped a STILL-current subagent
   * whenever the user steered or sent a consumed `followUp` while it was running: a steer's own
   * `kind: 'user'` transcript item is indistinguishable from a genuinely new turn by position
   * alone, since the runtime clears `runtime.subagents` only on `agent_start`, never on a steer
   * (same OMP run). Transcript position cannot resolve both failure modes at once, because the
   * transcript carries no field that tells a steer apart from a new turn. Scope is instead read
   * from `Session.currentTurnSubagents` (registry.json, data-model.md): the
   * `toolCallId:specIndex` keys `handleTaskStart` persists the instant a `task` call starts,
   * durably cleared only at `agent_start` -- the SAME boundary `runtime.subagents` uses, never by
   * a steer, a crash, or a Recover. A candidate from either source below is in scope here if and
   * only if its key is in that persisted set; `transcript.ts`'s `settleStaleSubagentRows` uses
   * the identical set to settle every OTHER `running` subagent row (one outside this turn) to
   * `exited` on the same `fromHistory` build.
   *
   * Gate fixes 2 finding 3: every `kind: 'subagent'` row in that same scope is seeded here, not
   * only the `running` ones -- a subagent that finished or failed before the crash is still part
   * of "this turn's subagents" (FR-007/FR-017) and must not silently disappear from the panel/chip
   * just because nothing left it `running`. Seeded with its REAL recorded status (`finished`/
   * `failed`); only a row still `running` with no live process left behind is ever resolved to
   * the terminal `exited` state.
   */
  private reconcileSubagentsOnAttach(): void {
    const transcript = this.runtime.transcript;

    // Durable turn marker: see the doc comment above -- scope is the persisted
    // `currentTurnSubagents` set, not transcript position.
    const currentTurnKeySet = new Set(currentTurnKeys(this.registry.getSession(this.sessionId)));

    interface Candidate {
      id: string;
      toolCallId: string;
      specIndex: number;
      nameOrTask: string;
      startedAt: number;
      startedAtKnown: boolean;
      transcriptId?: string;
      finalStatus: 'running' | 'done' | 'error' | 'exited';
    }
    const now = Date.now();

    // Gate fixes 2 finding 1: see the doc comment above. `settledKeys` maps every already-settled
    // `runtime.subagents` key to its recorded status, not just whether one exists.
    const settledKeys = new Map<string, SubagentSummary['status']>();
    const candidates = new Map<string, Candidate>();
    for (const s of this.runtime.subagents) {
      const key = `${s.toolCallId}:${s.specIndex}`;
      if (s.status !== 'running') {
        settledKeys.set(key, s.status);
        continue;
      }
      candidates.set(key, {
        id: s.id,
        toolCallId: s.toolCallId,
        specIndex: s.specIndex,
        nameOrTask: s.nameOrTask,
        startedAt: s.startedAt,
        startedAtKnown: true,
        finalStatus: 'running',
      });
    }
    // Gate fixes 3 (repeat-Recover row spins forever): a transcript row whose key is ALREADY in
    // `settledKeys` is never re-seeded as a new candidate (unchanged from gate fixes 2), but if
    // `fromHistory` is still rebuilding it as `running` (the data-layer defect the doc comment
    // above describes) it must be settled straight to the ALREADY-RECORDED summary's status --
    // `finished`/`failed` map to the transcript row's own `'done'`/`'error'`, `exited` stays
    // `exited` -- instead of being skipped outright. Gate fixes 2's bare `continue` here dropped
    // the row from `transcriptSettling` below entirely, so a SECOND Recover (or Recover then a
    // mode-change restart) with no new turn in between left the chat row spinning `running`
    // forever even though its summary had already settled, because `candidates.size === 0`
    // returned before any settling ran.
    const settledTranscriptStatus = new Map<string, 'done' | 'error' | 'exited'>();
    // Gate fixes 2 finding 3: see the doc comment above. Live verification found this must also
    // accept a row transcript.ts's own `settleStaleSubagentRows` (finding 5) already settled to
    // `'exited'` on THIS brand-new instance's very first `fromHistory` build: a true app restart
    // never has a `runtime.subagents` entry for it at all, so skipping an already-`'exited'` item
    // here (as an earlier draft did, reasoning it must already be in `settledKeys`) silently
    // dropped it from the panel/chip entirely instead of seeding it as a resolved candidate.
    for (let i = 0; i < transcript.length; i++) {
      const item = transcript[i]!;
      if (item.kind !== 'subagent') continue;
      const key = `${item.toolCallId}:${item.specIndex}`;
      // Durable turn marker: see the doc comment above -- a row outside the persisted scope
      // belongs to an earlier, already-concluded turn and is left for `settleStaleSubagentRows`
      // (transcript.ts) to settle to `exited` on the same `fromHistory` build, using this SAME
      // set; it is never re-seeded as "this turn's" here.
      if (!currentTurnKeySet.has(key)) continue;
      const settledStatus = settledKeys.get(key);
      if (settledStatus !== undefined) {
        if (item.status === 'running') {
          settledTranscriptStatus.set(
            item.id,
            settledStatus === 'finished' ? 'done' : settledStatus === 'failed' ? 'error' : 'exited',
          );
        }
        continue;
      }
      const existing = candidates.get(key);
      if (existing) {
        existing.transcriptId = item.id;
        if (item.status !== 'running') existing.finalStatus = item.status;
        continue;
      }
      candidates.set(key, {
        id: item.id,
        toolCallId: item.toolCallId,
        specIndex: item.specIndex,
        nameOrTask: item.name,
        startedAt: item.startedAt ?? now,
        startedAtKnown: item.startedAt !== undefined,
        transcriptId: item.id,
        finalStatus: item.status,
      });
    }
    if (candidates.size === 0 && settledTranscriptStatus.size === 0) return;

    if (candidates.size > 0) {
      // Gate finding 8: only report a duration where `startedAt` was ever genuinely known -- a
      // transcript row built from history with no wall clock at all must never show a fabricated
      // ~0s duration just because its placeholder `startedAt` was `now`.
      const resolved: SubagentSummary[] = [...candidates.values()].map((c) => {
        const status = c.finalStatus === 'done' ? 'finished' : c.finalStatus === 'error' ? 'failed' : 'exited';
        return {
          id: c.id,
          toolCallId: c.toolCallId,
          specIndex: c.specIndex,
          nameOrTask: c.nameOrTask,
          status,
          startedAt: c.startedAt,
          // Gate fixes 3 (medium): `exited` is resolved with no RPC round trip and no real end
          // time, so `now - startedAt` would count the entire app-downtime window the crash and
          // restart spanned (can be hours), not the subagent's own runtime -- never fabricate a
          // duration for an `exited` row.
          ...(c.startedAtKnown && status !== 'exited' ? { durationMs: Math.max(0, now - c.startedAt) } : {}),
        };
      });

      // Gate finding 3/6: a candidate seeded purely from the transcript (no live
      // `tool_execution_update` this run) never had a `subagentStreams` entry; selecting it in the
      // panel must never throw not-found, so give it an explanatory placeholder instead of leaving
      // it missing -- worded for whichever real status it actually settled to, not always "exited".
      // Gate fixes 2 finding 6 (live verification, 2026-10-07): an id CAN already have an entry
      // that is itself empty -- a batch `task()` call seeds `[]` for every subagent id the instant
      // it starts (`applyToolExecutionStart`), before any progress frame ever arrives for one that
      // crashed before producing output -- so `.has()` alone missed exactly the orphaned-candidate
      // case this placeholder exists for (caught live: `chat.subagentSnapshot` returned `[]`,
      // `#subagent-panel` showed the row list with nothing below it, no explanation). An empty
      // existing entry is therefore treated the same as a missing one.
      for (const summary of resolved) {
        if ((this.subagentStreams.get(summary.id) ?? []).length === 0) {
          const verb = summary.status === 'finished' ? 'finished' : summary.status === 'failed' ? 'failed' : 'exited';
          this.subagentStreams.set(summary.id, [
            {
              kind: 'notice',
              id: `${summary.id}:reattach-notice`,
              level: 'info',
              text: `No live output: this subagent had already ${verb} when Refract reattached.`,
            },
          ]);
        }
      }

      // Gate fixes 2 finding 1: replace by `toolCallId`+`specIndex`, never by `id` -- the two sides
      // use unrelated id schemes (see the doc comment above), so filtering the OLD list by the NEW
      // summaries' own `id`s would leave the stale entry behind, duplicating it instead of
      // replacing it.
      const resolvedKeys = new Set(resolved.map((r) => `${r.toolCallId}:${r.specIndex}`));
      this.runtime = {
        ...this.runtime,
        subagents: [...this.runtime.subagents.filter((s) => !resolvedKeys.has(`${s.toolCallId}:${s.specIndex}`)), ...resolved],
      };
      this.emit('subagents', { sessionId: this.sessionId, subagents: this.runtime.subagents });
    }

    // Gate finding 4: settle the matching chat-transcript row too -- without this the chat line
    // keeps spinning "running" forever while the panel already shows the real state. Seeded from
    // both `settledTranscriptStatus` (gate fixes 3, rows whose summary was already settled before
    // this reconcile ran) and the candidates resolved just above.
    const transcriptSettling = new Map<string, 'done' | 'error' | 'exited'>(settledTranscriptStatus);
    for (const c of candidates.values()) {
      if (c.transcriptId === undefined) continue;
      transcriptSettling.set(c.transcriptId, c.finalStatus === 'running' ? 'exited' : c.finalStatus);
    }
    if (transcriptSettling.size > 0) {
      const nextTranscript = this.runtime.transcript.map((item) =>
        item.kind === 'subagent' && item.status === 'running' && transcriptSettling.has(item.id)
          ? { ...item, status: transcriptSettling.get(item.id)! }
          : item,
      );
      const ops = diffTranscript(this.runtime.transcript, nextTranscript);
      this.runtime = { ...this.runtime, transcript: nextTranscript };
      this.queuePatch(ops);
    }
    // Gate fixes 2 finding 8: no `scheduleReadoutUpdate()` call here -- both callers
    // (`launch()`, `openConversation()`) already `await this.syncFromState(...)` immediately
    // after this method returns, synchronously-before-that mutating `this.runtime`, and
    // `syncFromState` unconditionally calls `scheduleReadoutUpdate()` itself at its own tail; an
    // explicit call here would just schedule a second, no-op recompute (`scheduleReadoutUpdate`
    // is a no-op while a timer is already pending -- `READOUT_COALESCE_MS`, `runReadoutUpdate`).
    // An earlier draft of this comment claimed this call "caught and fixed a real bug" where the
    // chip stayed stale forever without it; that was never actually true for either call site --
    // `scheduleReadoutUpdate`'s own debounce means a caller reading from a live `readout:update`
    // push (rather than the synchronous `recover()`/`openConversation()` response) can still see
    // a stale value for up to `READOUT_COALESCE_MS` (50ms), which is real and worth knowing, but
    // is not a bug this method introduced or fixed.
  }

  /** `chat.setVisibleSubagent` (FR-017 to FR-020): no immediate push -- the caller fetches the
   * current snapshot via `subagentSnapshot` first; only subsequent changes arrive as patches. */
  setVisibleSubagent(subagentId: string | null): void {
    this.visibleSubagentId = subagentId;
  }

  /** `chat.subagentSnapshot` (FR-018): throws for an id that never matched a `SubagentSummary`
   * of the current turn, mapped to `not-found` by the IPC layer. */
  subagentSnapshot(subagentId: string): TranscriptItem[] {
    const stream = this.subagentStreams.get(subagentId);
    if (!stream) {
      throw new Error(`SessionAgent ${this.sessionId}: no subagent ${subagentId} in the current turn`);
    }
    return stream;
  }

}
