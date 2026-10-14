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
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- one call per lane module each,
// cheap and allocation-free as a no-op; lane R3 adds its start queue behaviour inside these
// functions, never inside any file under `session/agent/`.

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
/// Mirrors `memory.ts`'s own `LOW_MEMORY_BYTES`.
const LOW_MEMORY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
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
/// None`) covers both "not starting" and "starting, but not currently waiting on anything worth
/// a banner for" (connecting, or settling after the ready frame arrives) -- the wire shape
/// (`SessionStartProgress`, `src/shared/model.ts`) has no variant for either, so neither needs
/// one here.
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
    /// Terminal: the user (or a caller acting for them) cancelled the start outright.
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
/// second) is always legal. `Cancelled` is terminal: nothing transitions out of it. See the unit
/// tests below for the illegal cases this rejects.
pub(super) fn validate_transition(
    current: Option<StartStage>,
    next: StartStage,
) -> Result<(), String> {
    use StartStage::{Cancelled, Extended, MemoryDeferred, Prompt, Queued, Waiting};
    let legal = match current {
        None => matches!(next, Queued | Waiting),
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
}

impl State {
    /// `SessionStartProgress` (`src/shared/model.ts`): `None` while nothing is in flight, so
    /// `agent/mod.rs`'s own status/snapshot builders omit the field entirely (gate rule: omit
    /// absent optional fields, never emit JSON `null`).
    pub(super) fn to_wire(&self) -> Option<Value> {
        let stage = self.stage?;
        Some(match stage {
            StartStage::Queued => json!({ "kind": "queued" }),
            StartStage::MemoryDeferred => {
                json!({ "kind": "memory-deferred", "elapsedMs": self.elapsed_ms })
            }
            _ => json!({ "kind": stage.wire_kind(), "elapsedMs": self.elapsed_ms }),
        })
    }
}

async fn set_stage(agent: &SessionAgent, next: StartStage, elapsed_ms: u64) {
    agent
        .with_start_queue_state(|s| {
            if validate_transition(s.stage, next).is_ok() {
                s.stage = Some(next);
                s.elapsed_ms = elapsed_ms;
            }
        })
        .await;
    agent.emit_status().await;
}

async fn clear_stage(agent: &SessionAgent) {
    agent
        .with_start_queue_state(|s| {
            s.stage = None;
            s.elapsed_ms = 0;
        })
        .await;
}

fn is_memory_low() -> bool {
    free_memory_bytes().is_some_and(|free| free < LOW_MEMORY_BYTES)
}

#[cfg(target_os = "windows")]
fn free_memory_bytes() -> Option<u64> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // Safety: `status` is sized and `dwLength`-stamped exactly as the API requires, a local on
    // this function's own stack that outlives the call.
    unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
    Some(status.ullAvailPhys)
}

#[cfg(not(target_os = "windows"))]
fn free_memory_bytes() -> Option<u64> {
    None
}

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

/// Port of `acquireStartSlot` + `deferStartIfMemoryLow`, called once near the top of
/// `agent::launch`'s own `launch()` (the "one hook" issue #786 adds to core `agent.rs`). Resolves
/// once a process-wide start slot is held and the machine is no longer under memory pressure (or
/// `MEMORY_DEFER_CEILING_MS` has elapsed), or rejects if `cancel_start`/`keepWaitingForStart`'s
/// cancel path fired first.
pub(super) async fn acquire_slot(agent: &SessionAgent) -> Result<SlotGuard, AgentError> {
    let cancel = Arc::new(Notify::new());
    agent
        .with_start_queue_state(|s| {
            s.cancel = Some(cancel.clone());
            s.stage = None;
            s.elapsed_ms = 0;
        })
        .await;

    let cancelled_err = || AgentError::new("not-started", "SessionAgent: start cancelled");

    let permit = match START_SLOTS.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            set_stage(agent, StartStage::Queued, 0).await;
            tokio::select! {
                res = START_SLOTS.acquire() => res.map_err(|_| cancelled_err())?,
                _ = cancel.notified() => {
                    set_stage(agent, StartStage::Cancelled, 0).await;
                    return Err(cancelled_err());
                }
            }
        }
    };

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
                set_stage(agent, StartStage::Cancelled, elapsed_ms).await;
                return Err(cancelled_err());
            }
        }
    }

    clear_stage(agent).await;
    Ok(SlotGuard { _permit: permit })
}

/// Pairing of `acquire_slot`'s own cancel handle with the ready-wait phase (`OmpProcess::
/// wait_ready`, once the child has actually spawned): a cancel arriving here must kill the
/// process, not just abandon the wait (issue #656: "leave no orphan process"). Spawned once,
/// right after `connect()` succeeds, released (its watcher task ends) once the started attempt
/// settles either way.
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
    let cancel = agent.with_start_queue_state(|s| s.cancel.clone()).await;
    let (done_tx, mut done_rx) = oneshot::channel();
    if let Some(cancel) = cancel {
        let agent = agent.arc();
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel.notified() => {
                    proc.stop().await;
                    set_stage(&agent, StartStage::Cancelled, 0).await;
                }
                _ = &mut done_rx => {}
            }
        });
    }
    CancelWatch {
        done_tx: Some(done_tx),
    }
}

impl SessionAgent {
    /// `sessions.keepWaitingForStart` (issue #512's "Keep waiting" button): dismisses the prompt
    /// without affecting the ceiling. A no-op (still `ok: true` at the IPC layer) if the Session
    /// is not currently at the `prompt` stage.
    pub(crate) async fn keep_waiting_for_start(&self) {
        let elapsed_ms = self.with_start_queue_state(|s| s.elapsed_ms).await;
        set_stage(self, StartStage::Extended, elapsed_ms).await;
    }

    /// `sessions.cancelStart` (issue #512's "Cancel" button): fails an in-flight start
    /// immediately -- while still queued or memory-deferring (`acquire_slot`'s own cancel
    /// check), or already spawned and waiting on the ready frame (`watch_for_cancel`, which also
    /// stops the process so issue #656 never leaves an orphan). A no-op if the Session is not
    /// currently starting (no cancel handle armed).
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

pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    // Defensive cleanup: a stale cancel handle or stage from this attempt must never leak into
    // whatever the next `launch()` attempt does.
    agent
        .with_start_queue_state(|s| {
            s.stage = None;
            s.elapsed_ms = 0;
            s.cancel = None;
        })
        .await;
}

pub(super) async fn on_start_progress(
    agent: &SessionAgent,
    stage: ReadyWaitStage,
    elapsed_ms: u64,
) {
    // The ready-wait ticker (`omp::process::wait_for_ready`) only ever reports `Waiting`/
    // `Prompt` (see that enum's own doc comment); `Extended` is this lane's own addition, driven
    // by `keep_waiting_for_start` rather than by anything `wait_for_ready` itself observes, so a
    // Session already `Extended` must keep reporting `Extended` on every later tick instead of
    // reverting to `Prompt`.
    let already_extended = agent
        .with_start_queue_state(|s| s.stage == Some(StartStage::Extended))
        .await;
    let next = match (stage, already_extended) {
        (_, true) => StartStage::Extended,
        (ReadyWaitStage::Waiting, false) => StartStage::Waiting,
        (ReadyWaitStage::Prompt, false) => StartStage::Prompt,
    };
    set_stage(agent, next, elapsed_ms).await;
}

#[cfg(test)]
#[path = "start_queue.test.rs"]
mod tests;
