// Agent start queue: process-wide start gate and staged ready-wait (issues #512, #706, #709).
// `StartStage` makes every legal start transition explicit; `validate_transition` rejects the rest.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{oneshot, Notify, Semaphore, SemaphorePermit};
use tokio::time::Instant;

use crate::omp::process::{OmpProcess, ReadyWaitStage};

use super::agent::{AgentError, SessionAgent};

/// Small enough that a burst of starts cannot exhaust memory before the low-memory defer acts.
const MAX_CONCURRENT_STARTS: usize = 2;
/// Past this much deferral the start proceeds regardless: slow beats never.
const MEMORY_DEFER_CEILING_MS: u64 = 60_000;
const MEMORY_DEFER_POLL_MS: u64 = 2_000;

static START_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(MAX_CONCURRENT_STARTS));

/// Counts only starts that have spawned a child process; only those consume memory worth deferring for.
static SPAWNED_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Every stage a start can be in while in flight. `None` also covers a cancelled start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StartStage {
    /// Waiting for a process-wide start slot.
    Queued,
    /// Holding a slot, waiting for `memory.ts`'s own low-memory signal to clear.
    MemoryDeferred,
    /// Spawned; waiting for the `ready` frame, before the prompt threshold.
    Waiting,
    /// Past the prompt threshold: the caller should offer "Keep waiting"/"Cancel".
    Prompt,
    /// The user chose "Keep waiting": dismisses the prompt without affecting the ceiling.
    Extended,
    /// Terminal. Never reaches the wire (`to_wire` maps it to `None`).
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

/// Checks every legal edge explicitly; `current == next` is always legal, and `Cancelled` is terminal.
/// The atomic callers (`keep_waiting_for_start`, `on_start_progress`) check and apply under one lock.
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

/// Runtime start state, held inside `AgentState`.
#[derive(Default)]
pub(super) struct State {
    stage: Option<StartStage>,
    elapsed_ms: u64,
    /// Fresh per start attempt; a stale handle from an earlier attempt must not cancel a later one.
    cancel: Option<Arc<Notify>>,
    /// True only during the ready-wait phase. Ignores late ticks from an already-settled attempt,
    /// which the transition table alone cannot tell apart from a fresh start.
    ready_wait_active: bool,
    /// Set when a cancel already recorded the clean status for this exit. Reset per attempt.
    cancel_already_recorded: bool,
}

impl State {
    /// `None` while nothing is in flight, so the status builders omit the field (never JSON `null`).
    /// `Cancelled` maps to `None` too: the user sees a `stopped` status, not a distinct stage.
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

/// Applies `next` if legal from the current stage. A rejection is logged and `debug_assert!`-ed,
/// since it means a bug in this lane's call graph. Re-emits status only when the stage changed.
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

/// Clears the in-flight stage and re-emits status so the start banner disappears.
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

/// Clears any lingering waiting/prompt stage the moment the Session is ready.
pub(super) async fn clear_stage_on_ready(agent: &SessionAgent) {
    clear_stage(agent).await;
}

/// Clears the stage on every return path, so a failed start never leaves a stuck banner.
/// Drop cannot await, so the clear is spawned fire-and-forget.
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

// Re-exported from `shell::memory` (the one canonical low-memory check) so this call site is unchanged.
use crate::shell::memory::is_memory_low;

pub(super) fn mark_spawned() -> SpawnedGuard {
    SPAWNED_COUNT.fetch_add(1, Ordering::SeqCst);
    SpawnedGuard { armed: true }
}

fn spawned_in_flight() -> usize {
    SPAWNED_COUNT.load(Ordering::SeqCst)
}

/// Releases the spawned-start count exactly once, on every return path of the launch attempt.
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

/// Frees the process-wide start slot exactly once, whichever path the launch returns through.
pub(super) struct SlotGuard {
    _permit: SemaphorePermit<'static>,
}

/// Ends a cancelled start. A deliberate stop (`stop_requested`) ends `not-started` with no notice;
/// a plain cancel ends `start-failed` with a notice. `stop_requested` is re-checked here.
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

/// Checked up front and on every wait-loop iteration, so a `shutdown()` racing a new start is honoured.
/// Always ends `not-started` with no notice.
async fn bail_if_stop_requested(agent: &SessionAgent) -> bool {
    if agent.stop_requested().await {
        clear_stage(agent).await;
        agent.mark_stopped_not_started().await;
        true
    } else {
        false
    }
}

/// Waits for a start slot and low memory to clear (or the defer ceiling). Rejects on cancel/shutdown.
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

/// Kills the spawned child on cancel during the ready wait, so no orphan process is left (#656).
/// Released once the started attempt settles, either way.
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
                    // Set before `proc.stop()`, so `launch()` always sees it when `wait_ready` errors.
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

/// Read-and-reset, so a cancel-caused `wait_ready` error is reported only once.
pub(super) async fn take_cancel_already_recorded(agent: &SessionAgent) -> bool {
    agent
        .with_start_queue_state(|s| std::mem::take(&mut s.cancel_already_recorded))
        .await
}

impl SessionAgent {
    /// Dismisses the start prompt. No-ops outside `Prompt`. The check and write share one lock,
    /// so a racing clear or cancel is a silent no-op rather than a panic.
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

    /// Fails an in-flight start, from a user cancel or from `shutdown()`. No-op when not starting.
    pub(crate) async fn cancel_start(&self) {
        let cancel = self.with_start_queue_state(|s| s.cancel.clone()).await;
        if let Some(cancel) = cancel {
            // `notify_one` stores a permit, so a cancel landing before the next `.notified()` is not lost.
            cancel.notify_one();
        }
    }
}

pub(super) async fn on_frame(_agent: &SessionAgent, _frame_type: &str, _frame: &Value) {
    // No-op: the ready frame settles through `OmpProcess::wait_ready`/`launch()`, not here.
}

/// Clears start state on exit. `stop_requested` is unused here, kept to match `termination`'s `on_exit`.
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
    // Ignores stale ticks after the ready-wait phase ended. The check and the write share one lock,
    // so a racing clear can only make this a no-op.
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
