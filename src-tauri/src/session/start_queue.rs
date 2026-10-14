// Agent start queue (issue #512: start-progress banner, staged wait) (lane R3, issue #786).
// Pre-declared so lane R3 is the only lane that ever edits this file (issue #784, "Pre-declare
// per-lane Rust files").
//
// Port of `src/main/omp/startQueue.ts` (the process-wide concurrency gate, issue #512
// requirement 5: "start agents one or two at a time") and the staged-wait half of
// `src/main/omp/readyWait.ts`/`OmpProcess.ts`'s own `deferStartIfMemoryLow` (the low-memory
// defer), recast as issues #706/#709's typed state machine: `StartStage` makes every legal start
// transition explicit and every illegal one a rejected `validate_transition` call (unit-tested
// below), rather than the flag-soup `startCancelled`/`hasMarkedSpawned`/`readyWait` trio the TS
// port threads through `OmpProcess.start()` by hand.
//
// `on_frame` is the one extension point `agent::frame`'own `handle_frame` calls for every decoded
// frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`, which gates
// this lane's own `on_exit` on `is_current` and threads through `stop_requested` -- see that
// call site's own comment), and `on_start_progress` for the ready-wait banner (same listener) --
// lane R3 adds its start queue behaviour inside these functions, never inside any file under
// `session/agent/`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{oneshot, Notify, Semaphore, SemaphorePermit};
use tokio::time::Instant;

use crate::omp::process::{OmpProcess, ReadyWaitStage};

use super::agent::{AgentError, SessionAgent};

/// Issue #512 requirement 5: on a busy machine two slow Session starts could each hold a queue
/// slot for up to the ready-wait ceiling (180s), so this stays small -- large enough that a
/// typical session's worth of concurrent starts does not queue needlessly, small enough that a
/// burst of starts cannot itself exhaust memory before the defer below ever gets a chance to act.
const MAX_CONCURRENT_STARTS: usize = 2;
// Issue #788 (lane R5): the low-memory threshold moved to `shell::memory::LOW_MEMORY_BYTES`
// (the one canonical copy `is_memory_low()` below now reads) instead of staying duplicated here.
/// Mirrors `OmpProcess.ts`'s own `MEMORY_DEFER_CEILING_MS`: gives up deferring and lets the start
/// proceed regardless once this much time has passed -- a start that is merely slow is still
/// better than one that never happens.
const MEMORY_DEFER_CEILING_MS: u64 = 60_000;
const MEMORY_DEFER_POLL_MS: u64 = 2_000;

static START_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(MAX_CONCURRENT_STARTS));

/// Gate-fixes Medium finding (cycle 6, `startQueue.ts`'s own header): counts only starts that
/// have ACTUALLY spawned a child process -- the only kind of "in flight" that is really
/// consuming memory and worth deferring behind. A start still holding a queue slot but not yet
/// spawned does not count.
static SPAWNED_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Issue #706/#709: every stage a start can be in while in flight. Absent (`State.stage ==
/// None`) covers "not starting", "starting, but not currently waiting on anything worth a banner
/// for" (connecting, or settling after the ready frame arrives), AND "the start just got
/// cancelled" (gate-fix: `Cancelled` itself is never put on the wire -- see `to_wire` -- so a
/// caller that reads `State.stage` right after a cancel sees the same "nothing in flight" shape
/// either way).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StartStage {
    /// Waiting for a process-wide start slot (issue #512 requirement 5).
    Queued,
    /// Holding a slot, waiting for `memory.ts`'s own low-memory signal to clear.
    MemoryDeferred,
    /// Spawned; waiting for the `ready` frame, before the prompt threshold.
    Waiting,
    /// Past the prompt threshold: the caller should offer "Keep waiting"/"Cancel".
    Prompt,
    /// The user chose "Keep waiting": dismisses the prompt without affecting the ceiling.
    Extended,
    /// Terminal: the user (or a caller acting for them) cancelled the start outright. Never
    /// reaches the wire (`to_wire` maps it to `None`, same as "nothing in flight").
    Cancelled,
}

impl StartStage {
    fn wire_kind(self) -> &'static str {
        match self {
            StartStage::Queued => "queued",
            StartStage::MemoryDeferred => "memory-deferred",
            StartStage::Waiting => "waiting",
            StartStage::Prompt => "prompt",
            StartStage::Extended => "extended",
            StartStage::Cancelled => "cancelled",
        }
    }
}

/// Issue #706/#709's own "illegal transitions unrepresentable" requirement: every legal edge in
/// the state machine, checked explicitly rather than left to whichever caller happens to set
/// `State.stage` next. `current == next` (the ready-wait ticker re-emitting the same stage every
/// second) is always legal. `None -> MemoryDeferred`/`None -> Cancelled` are both legal starting
/// points too (a start can begin already under memory pressure with its slot granted
/// immediately -- no `Queued` stage at all -- and a cancel can land in the same narrow window,
/// before any stage was ever set). `Cancelled` is terminal: nothing transitions out of it.
///
/// Gate-fix (code review HIGH, round 2; revised round 6): `keep_waiting_for_start` and
/// `on_start_progress` -- the two callers whose own precondition can race a concurrent
/// `clear_stage`/cancel -- no longer go through `set_stage` at all; each checks its own
/// precondition, calls this function, and applies the result inside ONE atomic
/// `with_start_queue_state` closure, so a race can only ever make this return `Err` as a benign
/// no-op for them, never a bug to assert on. `set_stage`'s own remaining callers (`acquire_slot`)
/// are not racy the same way (sequential within one `launch()` attempt) -- see `set_stage`'s own
/// doc comment for why a rejection THERE still means a real bug.
pub(super) fn validate_transition(
    current: Option<StartStage>,
    next: StartStage,
) -> Result<(), String> {
    use StartStage::{Cancelled, Extended, MemoryDeferred, Prompt, Queued, Waiting};
    let legal = match current {
        None => matches!(next, Queued | MemoryDeferred | Waiting | Cancelled),
        Some(Queued) => matches!(next, Queued | MemoryDeferred | Waiting | Cancelled),
        Some(MemoryDeferred) => matches!(next, MemoryDeferred | Waiting | Cancelled),
        Some(Waiting) => matches!(next, Waiting | Prompt | Cancelled),
        Some(Prompt) => matches!(next, Prompt | Extended | Cancelled),
        Some(Extended) => matches!(next, Extended | Cancelled),
        Some(Cancelled) => false,
    };
    if legal {
        Ok(())
    } else {
        Err(format!(
            "start_queue: illegal transition {current:?} -> {next:?}"
        ))
    }
}

/// Lane R3's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_start_queue_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    stage: Option<StartStage>,
    elapsed_ms: u64,
    /// Fresh per start attempt (created in `acquire_slot`, cleared once the attempt settles so a
    /// stale handle from an earlier attempt can never cancel a later, unrelated one).
    cancel: Option<Arc<Notify>>,
    /// True only during the actual ready-wait phase: set by `watch_for_cancel` (called once,
    /// right after `connect()` succeeds), cleared by `clear_stage`/`on_exit`. Gate-fix (code
    /// review HIGH, round 2): `on_start_progress` ignores every tick while this is `false` -- the
    /// frame-listener task can still have a STALE `StartProgress` event queued from the SAME
    /// attempt's own `wait_for_ready` ticker, delivered AFTER `wait_ready()` has already returned
    /// (ready or failed) and the stage already cleared. `None -> Waiting` is legal by the
    /// transition table alone (a genuinely fresh start is allowed to begin there -- gate round
    /// 4, LOW: corrected, `None -> Prompt` is NOT also legal, `validate_transition`'s own `None`
    /// arm never includes `Prompt`), so the table on its own cannot tell a late, stale `Waiting`
    /// tick from this same attempt apart from a brand new one; this flag can.
    ready_wait_active: bool,
    /// Set by `watch_for_cancel`'s own cancel branch (round 4), read-and-reset by
    /// `agent::launch`'s own `launch()` right after `wait_ready` errors (the same `proc.stop()`
    /// kill that causes that error): lets `launch()` tell "a cancel already recorded a clean
    /// status for this exact exit" apart from a genuine ready-wait failure, instead of
    /// re-recording a wrong, raw failure on top of the clean one (found live, round 4 CDP
    /// check). Reset at the top of every fresh `acquire_slot` attempt so a stale `true` from an
    /// earlier attempt that never reached `wait_ready` can never suppress a LATER attempt's own
    /// genuine failure notice. See `take_cancel_already_recorded`'s own doc comment.
    cancel_already_recorded: bool,
}

impl State {
    /// `SessionStartProgress` (`src/shared/model.ts`): `None` while nothing is in flight, so
    /// `agent/mod.rs`'s own status/snapshot builders omit the field entirely (gate rule: omit
    /// absent optional fields, never emit JSON `null`). `Cancelled` ALSO maps to `None`
    /// (gate-fix): `SessionStartProgress`'s own union has no `'cancelled'` variant at all --
    /// the real, user-visible outcome of a cancel is a `stopped` status moments later, same as
    /// any other failed start, never a distinct wire stage.
    pub(super) fn to_wire(&self) -> Option<Value> {
        let stage = self.stage?;
        if stage == StartStage::Cancelled {
            return None;
        }
        Some(match stage {
            StartStage::Queued => json!({ "kind": "queued" }),
            StartStage::MemoryDeferred => {
                json!({ "kind": "memory-deferred", "elapsedMs": self.elapsed_ms })
            }
            _ => json!({ "kind": stage.wire_kind(), "elapsedMs": self.elapsed_ms }),
        })
    }
}

/// Applies `next` if (and only if) legal from the Session's current stage (`validate_transition`,
/// gate-fix: a rejected transition is never silently swallowed -- it is logged AND
/// `debug_assert!`-ed). Used only by `acquire_slot`'s own sequential transitions (Queued/
/// MemoryDeferred) now (round 6: `keep_waiting_for_start`/`on_start_progress` apply atomically
/// themselves instead, see `validate_transition`'s own doc comment) -- a rejection here means a
/// real bug in THIS lane's call graph, not a routine UI/process race. Re-emits status only when
/// the stage actually changed.
async fn set_stage(agent: &SessionAgent, next: StartStage, elapsed_ms: u64) {
    let applied = agent
        .with_start_queue_state(|s| match validate_transition(s.stage, next) {
            Ok(()) => {
                s.stage = Some(next);
                s.elapsed_ms = elapsed_ms;
                true
            }
            Err(msg) => {
                log::error!("session::start_queue: {msg}");
                false
            }
        })
        .await;
    debug_assert!(
        applied,
        "session::start_queue: rejected transition to {next:?} (see the log::error! just above)"
    );
    if applied {
        agent.emit_status().await;
    }
}

/// Clears the in-flight stage (nothing left to show) and re-emits status so the UI's
/// start-progress banner actually disappears -- called both defensively (`on_exit`) and
/// positively (`clear_stage_on_ready`/`StageGuard`). Also clears `ready_wait_active`: the
/// ready-wait phase, if this attempt was even in it, is over either way.
async fn clear_stage(agent: &SessionAgent) {
    let changed = agent
        .with_start_queue_state(|s| {
            let changed = s.stage.is_some();
            s.stage = None;
            s.elapsed_ms = 0;
            s.ready_wait_active = false;
            changed
        })
        .await;
    if changed {
        agent.emit_status().await;
    }
}

/// Called by `agent::launch`'s own `launch()` right after `OmpProcess::wait_ready` resolves
/// successfully: the Session is ready, so any lingering `waiting`/`prompt`/`extended` stage must
/// disappear from the wire immediately, not linger until the next unrelated status event happens
/// to clear it (TS's own `OmpProcess.ts` calls `setStartProgress(undefined)` at this exact point
/// too).
pub(super) async fn clear_stage_on_ready(agent: &SessionAgent) {
    clear_stage(agent).await;
}

/// Gate-fix (code review HIGH, round 2): a start that fails during `wait_ready` (ceiling, or the
/// process exiting before ready) used to leave its `waiting`/`prompt` stage stuck on the wire --
/// `launch()`'s own error-return path there never cleared it, since clearing only happened on
/// the SUCCESS path (`clear_stage_on_ready`) or defensively in `on_exit` (which only runs for a
/// process that actually exited, not a ceiling timeout against one that is merely stuck). One
/// guard for the WHOLE attempt instead: held from right after `acquire_slot` succeeds for the
/// rest of `launch()`'s own scope, it clears the stage on EVERY return path (success included --
/// `clear_stage` is idempotent, so the redundant clear on the happy path, after
/// `clear_stage_on_ready` already ran, is a harmless no-op). Spawns the actual async clear on
/// drop (fire-and-forget: a `Drop` impl cannot `.await`) -- a few milliseconds' delay on the
/// stage disappearing from the wire is immaterial next to the bug this closes (a banner stuck
/// forever).
pub(super) struct StageGuard {
    agent: Arc<SessionAgent>,
}

impl Drop for StageGuard {
    fn drop(&mut self) {
        let agent = self.agent.clone();
        tokio::spawn(async move {
            clear_stage(&agent).await;
        });
    }
}

pub(super) fn guard_stage_for_attempt(agent: &SessionAgent) -> StageGuard {
    StageGuard { agent: agent.arc() }
}

// Issue #788 (lane R5): `shell::memory` is now the one canonical low-memory check (its own
// sampler timer's threshold/`GlobalMemoryStatusEx` call) -- this lane's own private duplicate of
// both used to live here (`memory.ts`'s doc comment pointed the other way, "the start-queue
// memory defer reuses `isMemoryLow()`", before `shell/memory.rs` existed to reuse FROM). A plain
// re-export keeps this call site unchanged below.
use crate::shell::memory::is_memory_low;

pub(super) fn mark_spawned() -> SpawnedGuard {
    SPAWNED_COUNT.fetch_add(1, Ordering::SeqCst);
    SpawnedGuard { armed: true }
}

fn spawned_in_flight() -> usize {
    SPAWNED_COUNT.load(Ordering::SeqCst)
}

/// RAII pairing of `startQueue.ts`'s own `markSpawned`/`unmarkSpawned`: held for the rest of the
/// launch attempt's scope (`agent/launch.rs`'s own `launch()`), so the matching decrement runs
/// exactly once, on every return path, the same guarantee the TS port's own `finally` block
/// gives.
pub(super) struct SpawnedGuard {
    armed: bool,
}

impl Drop for SpawnedGuard {
    fn drop(&mut self) {
        if self.armed {
            SPAWNED_COUNT.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// RAII pairing of `acquireStartSlot`'s own release function: held for the rest of the launch
/// attempt's scope so the slot is freed exactly once, whichever path `launch()` returns through.
pub(super) struct SlotGuard {
    _permit: SemaphorePermit<'static>,
}

/// Ends an in-flight start that was cancelled (queued, memory-deferring, or already spawned and
/// waiting on the ready frame alike). Gate-fix (code review HIGH, round 3, FR-038): `shutdown()`
/// also calls `cancel_start()` (round 1's own fix), so the SAME `cancel` notification this
/// function handles can originate from either a genuine user `cancelStart()` OR a `shutdown()` --
/// `stop_requested` (re-checked HERE, not assumed from which call site fired the notify) is the
/// only way to tell them apart. A deliberate stop (`shutdown()`) ends as `stopped`/`not-started`
/// with NO failure notice (matching `launch()`'s own existing "stop requested during launch"
/// branches elsewhere); a plain `cancelStart()` alone ends as `start-failed` with a notice, the
/// same "failed to start" path TS funnels every other kind of start failure through.
async fn end_cancelled_attempt(agent: &SessionAgent) {
    clear_stage(agent).await;
    if agent.stop_requested().await {
        agent.mark_stopped_not_started().await;
    } else {
        agent
            .record_start_failure("SessionAgent: start cancelled")
            .await;
    }
}

/// Checked up front and again on every `acquire_slot` wait-loop iteration (a `shutdown()` that
/// races a brand-new `start()` must reach a start still queued or memory-deferring too, not only
/// an explicit `cancelStart()`). Always a deliberate stop by construction (the condition checked
/// to call this IS `stop_requested`), so this always ends as `not-started` with no notice -- see
/// `end_cancelled_attempt`'s own doc comment for why a plain cancel (no `stop_requested`) differs.
async fn bail_if_stop_requested(agent: &SessionAgent) -> bool {
    if agent.stop_requested().await {
        clear_stage(agent).await;
        agent.mark_stopped_not_started().await;
        true
    } else {
        false
    }
}

/// Port of `acquireStartSlot` + `deferStartIfMemoryLow`, called once near the top of
/// `agent::launch`'s own `launch()` (the "one hook" issue #786 adds to core `agent.rs`). Resolves
/// once a process-wide start slot is held and the machine is no longer under memory pressure (or
/// `MEMORY_DEFER_CEILING_MS` has elapsed), or rejects if `cancel_start`/`keepWaitingForStart`'s
/// cancel path fired first, OR if `shutdown()` already set `stop_requested` before this attempt
/// even got a slot.
pub(super) async fn acquire_slot(agent: &SessionAgent) -> Result<SlotGuard, AgentError> {
    let cancel = Arc::new(Notify::new());
    agent
        .with_start_queue_state(|s| {
            s.cancel = Some(cancel.clone());
            s.stage = None;
            s.elapsed_ms = 0;
            s.ready_wait_active = false;
            s.cancel_already_recorded = false;
        })
        .await;

    let cancelled_err = || AgentError::new("not-started", "SessionAgent: start cancelled");

    if bail_if_stop_requested(agent).await {
        return Err(cancelled_err());
    }

    let permit = match START_SLOTS.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            set_stage(agent, StartStage::Queued, 0).await;
            tokio::select! {
                res = START_SLOTS.acquire() => res.map_err(|_| cancelled_err())?,
                _ = cancel.notified() => {
                    end_cancelled_attempt(agent).await;
                    return Err(cancelled_err());
                }
            }
        }
    };

    if bail_if_stop_requested(agent).await {
        return Err(cancelled_err());
    }

    let started_at = Instant::now();
    loop {
        let elapsed_ms = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        if !is_memory_low() || spawned_in_flight() == 0 || elapsed_ms >= MEMORY_DEFER_CEILING_MS {
            break;
        }
        set_stage(agent, StartStage::MemoryDeferred, elapsed_ms).await;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(MEMORY_DEFER_POLL_MS)) => {},
            _ = cancel.notified() => {
                end_cancelled_attempt(agent).await;
                return Err(cancelled_err());
            }
        }
        if bail_if_stop_requested(agent).await {
            return Err(cancelled_err());
        }
    }

    clear_stage(agent).await;
    Ok(SlotGuard { _permit: permit })
}

/// Pairing of `acquire_slot`'s own cancel handle with the ready-wait phase (`OmpProcess::
/// wait_ready`, once the child has actually spawned): a cancel arriving here must kill the
/// process, not just abandon the wait (issue #656: "leave no orphan process"). Spawned once,
/// right after `connect()` succeeds (also the moment `ready_wait_active` turns `true`), released
/// (its watcher task ends) once the started attempt settles either way --
/// `agent::launch`'s own `launch()` drops the returned guard right after `wait_ready` itself
/// settles (gate-fix, code review MEDIUM, round 3: it used to be held across `attach_and_verify`/
/// `fetch_all_messages` too, so a cancel landing there could still kill an already-ready agent).
/// Ends the attempt via `end_cancelled_attempt` itself now (gate-fix, round 3): does not rely on
/// `wait_ready`'s own natural exit-detection error path to record the final status any more,
/// since that path cannot tell a genuine crash apart from this cancel's own `proc.stop()` and
/// would otherwise always record `start-failed`, even for a `shutdown()`-driven cancel that must
/// end as `not-started` with no notice.
pub(super) struct CancelWatch {
    done_tx: Option<oneshot::Sender<()>>,
}

impl Drop for CancelWatch {
    fn drop(&mut self) {
        if let Some(tx) = self.done_tx.take() {
            let _ = tx.send(());
        }
    }
}

pub(super) async fn watch_for_cancel(agent: &SessionAgent, proc: Arc<OmpProcess>) -> CancelWatch {
    let cancel = agent
        .with_start_queue_state(|s| {
            s.ready_wait_active = true;
            s.cancel.clone()
        })
        .await;
    let (done_tx, mut done_rx) = oneshot::channel();
    if let Some(cancel) = cancel {
        let agent = agent.arc();
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel.notified() => {
                    // Gate-fix (round 4, found live): set BEFORE `proc.stop()` -- that kill is
                    // what makes `wait_ready` (racing in `launch()`) observe the exit and
                    // error, so setting this strictly before it guarantees `launch()` always
                    // sees it set regardless of timing. See `State::cancel_already_recorded`.
                    agent
                        .with_start_queue_state(|s| s.cancel_already_recorded = true)
                        .await;
                    proc.stop().await;
                    end_cancelled_attempt(&agent).await;
                }
                _ = &mut done_rx => {}
            }
        });
    }
    CancelWatch {
        done_tx: Some(done_tx),
    }
}

/// Read-and-reset: `agent::launch`'s own `launch()` calls this once, right after `wait_ready`
/// errors, to tell a cancel-caused exit (already recorded cleanly) apart from a genuine
/// ready-wait failure -- resets so this only ever suppresses the ONE report it caused.
pub(super) async fn take_cancel_already_recorded(agent: &SessionAgent) -> bool {
    agent
        .with_start_queue_state(|s| std::mem::take(&mut s.cancel_already_recorded))
        .await
}

impl SessionAgent {
    /// `sessions.keepWaitingForStart` (issue #512's "Keep waiting" button): dismisses the prompt
    /// without affecting the ceiling. No-ops outside `Prompt` (a stale click racing a resolve
    /// must never throw/assert, matching TS's own `ReadyWaitController.keepWaiting`). Gate-fix
    /// (code review MEDIUM, round 6): the read and the write used to be two separate lock
    /// acquisitions (via `set_stage`, which `debug_assert!`s a rejected transition), so a
    /// `clear_stage`/cancel landing in the gap panicked the frame-listener task on a routine
    /// race. Now one atomic closure: check, `validate_transition`, and write all happen under
    /// the SAME lock, so a race can only ever be a silent no-op.
    pub(crate) async fn keep_waiting_for_start(&self) {
        let applied = self
            .with_start_queue_state(|s| {
                if s.stage != Some(StartStage::Prompt) {
                    return false;
                }
                if validate_transition(s.stage, StartStage::Extended).is_err() {
                    return false;
                }
                s.stage = Some(StartStage::Extended);
                true
            })
            .await;
        if applied {
            self.emit_status().await;
        }
    }

    /// `sessions.cancelStart` (issue #512's "Cancel" button) and `shutdown()` (gate-fix, TS
    /// cycles 2/3: a `shutdown()` that races a start in flight must reach it too, not only a
    /// `cancelStart()`). Fails an in-flight start immediately -- while still queued or
    /// memory-deferring (`acquire_slot`'s own cancel check), or already spawned and waiting on
    /// the ready frame (`watch_for_cancel`, which also stops the process so issue #656 never
    /// leaves an orphan). A no-op if the Session is not currently starting (no cancel handle
    /// armed).
    pub(crate) async fn cancel_start(&self) {
        let cancel = self.with_start_queue_state(|s| s.cancel.clone()).await;
        if let Some(cancel) = cancel {
            // `notify_one` (not `notify_waiters`): stores a permit for the NEXT `.notified()`
            // call if nobody is awaiting one right now (the narrow gap between `acquire_slot`
            // returning and `watch_for_cancel`'s own select arming) -- a single always-sequential
            // waiter, so "wake whoever is currently waiting, or arm for whoever waits next" is
            // exactly the semantics this needs; `notify_waiters` would silently drop a cancel
            // that lands in that gap.
            cancel.notify_one();
        }
    }
}

pub(super) async fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op: nothing frame-level affects the start queue (the ready frame itself settles through
    // `OmpProcess::wait_ready`/`launch()`, not through the live frame listener).
}

/// `agent::frame`'s own `spawn_frame_listener` dispatch gates this call on `is_current` (never
/// invoked for a stale exit belonging to an already-superseded life, gate-fix: a stale exit must
/// never clear the NEW attempt's own cancel handle/stage), so this always runs for the Session's
/// own current life. `stop_requested` is unused here (the stage/cancel cleanup below applies
/// regardless of why the process exited), kept only so this lane's `on_exit` has the same shape
/// `session::termination`'s own `on_exit` needs it for.
pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, _stop_requested: bool) {
    agent
        .with_start_queue_state(|s| {
            s.stage = None;
            s.elapsed_ms = 0;
            s.cancel = None;
            s.ready_wait_active = false;
        })
        .await;
}

pub(super) async fn on_start_progress(
    agent: &SessionAgent,
    stage: ReadyWaitStage,
    elapsed_ms: u64,
) {
    // Gate-fix (code review HIGH, round 2): ignores every tick once the ready-wait phase this
    // attempt was in has already ended (`ready_wait_active` false) -- a STALE tick from the SAME
    // attempt's own ticker, delivered AFTER `clear_stage_on_ready`/`StageGuard` already cleared
    // the stage, would otherwise be indistinguishable from a genuinely new attempt. See
    // `State::ready_wait_active`'s own doc comment.
    //
    // Gate-fix (code review MEDIUM, round 6): the read and the later `set_stage` write used to
    // be two separate lock acquisitions -- a `clear_stage`/cancel landing in the gap panicked
    // the frame-listener task on a routine race (`set_stage`'s own `debug_assert!`). Now one
    // atomic closure: the `ready_wait_active` check, stage decision, `validate_transition`, and
    // write all happen under the SAME lock, so a race can only ever be a silent no-op.
    let applied = agent
        .with_start_queue_state(|s| {
            if !s.ready_wait_active {
                return false;
            }
            let already_extended = s.stage == Some(StartStage::Extended);
            let next = match (stage, already_extended) {
                (_, true) => StartStage::Extended,
                (ReadyWaitStage::Waiting, false) => StartStage::Waiting,
                (ReadyWaitStage::Prompt, false) => StartStage::Prompt,
            };
            if validate_transition(s.stage, next).is_err() {
                return false;
            }
            s.stage = Some(next);
            s.elapsed_ms = elapsed_ms;
            true
        })
        .await;
    if applied {
        agent.emit_status().await;
    }
}

#[cfg(test)]
#[path = "start_queue.test.rs"]
mod tests;
