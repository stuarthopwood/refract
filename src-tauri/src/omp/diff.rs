// Transcript diffing and patch coalescing; change detection is by `Arc` pointer identity, O(n) (#776).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::transcript::{SubagentStatus, ToolStatus, TranscriptItem};

/// Wire-identical to `src/shared/ipc.ts`'s `TranscriptOp`.
// `Upsert` is boxed (clippy `large_enum_variant`); `Reset` holds `Arc`s so queuing it only bumps refcounts.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum TranscriptOp {
    Reset { items: Vec<Arc<TranscriptItem>> },
    Upsert { item: Box<TranscriptItem> },
}

/// Builds the `TranscriptOp`s that bring a subscriber from `prev` to `next`.
// A removed item has no op, so it forces a `reset`. Upstream only rewraps an item in a fresh
// `Arc` when it changed, so `Arc::ptr_eq` is an O(1) "changed" signal.
pub fn diff_transcript(
    prev: &[Arc<TranscriptItem>],
    next: &[Arc<TranscriptItem>],
) -> Vec<TranscriptOp> {
    if prev.is_empty() {
        return if next.is_empty() {
            Vec::new()
        } else {
            vec![TranscriptOp::Reset {
                items: next.to_vec(),
            }]
        };
    }
    let next_ids: HashSet<&str> = next.iter().map(|item| item.id()).collect();
    let any_removed = prev.iter().any(|item| !next_ids.contains(item.id()));
    if any_removed {
        return vec![TranscriptOp::Reset {
            items: next.to_vec(),
        }];
    }
    let prev_by_id: HashMap<&str, &Arc<TranscriptItem>> =
        prev.iter().map(|item| (item.id(), item)).collect();
    let mut ops = Vec::new();
    for item in next {
        match prev_by_id.get(item.id()) {
            Some(before) if Arc::ptr_eq(before, item) => {}
            _ => ops.push(TranscriptOp::Upsert {
                item: Box::new((**item).clone()),
            }),
        }
    }
    ops
}

/// Appends live items that history cannot contain (unresolved requests, running or streaming items).
// `start()`/`restart()` refetch history; a plain replace would drop frames that arrived meanwhile.
pub fn merge_history_with_live(
    history: &[Arc<TranscriptItem>],
    live: &[Arc<TranscriptItem>],
) -> Vec<Arc<TranscriptItem>> {
    let history_ids: HashSet<&str> = history.iter().map(|item| item.id()).collect();
    let is_unpersisted = |item: &&Arc<TranscriptItem>| -> bool {
        if history_ids.contains(item.id()) {
            return false;
        }
        match item.as_ref() {
            TranscriptItem::Request { resolved, .. } => resolved.is_none(),
            TranscriptItem::Tool { status, .. } => *status == ToolStatus::Running,
            TranscriptItem::Subagent { status, .. } => *status == SubagentStatus::Running,
            TranscriptItem::AssistantText { streaming, .. } => *streaming,
            TranscriptItem::Thinking { streaming, .. } => *streaming,
            _ => false,
        }
    };
    let extra: Vec<Arc<TranscriptItem>> = live
        .iter()
        .filter(|item| is_unpersisted(item))
        .cloned()
        .collect();
    if extra.is_empty() {
        history.to_vec()
    } else {
        history.iter().cloned().chain(extra).collect()
    }
}

/// Why the OMP process exited mid-turn; a user stop must never read as a failure (#563, #911).
#[derive(Clone, Copy, Debug)]
pub enum SubagentFinalizeCause {
    /// The user asked the session to stop; running rows settle to `Cancelled`.
    UserStop,
    /// Any other exit; running subagents settle to `Exited`, tools to `Error`.
    Crash,
}

/// Settles running tool/subagent rows per `cause` and ends streaming text/thinking.
// Otherwise those items spin forever and `merge_history_with_live` re-appends them on later launches.
pub fn finalize_live_transcript(
    mut transcript: Vec<Arc<TranscriptItem>>,
    cause: SubagentFinalizeCause,
) -> Vec<Arc<TranscriptItem>> {
    for item in transcript.iter_mut() {
        let needs_finalize = matches!(
            item.as_ref(),
            TranscriptItem::Tool {
                status: ToolStatus::Running,
                ..
            } | TranscriptItem::Subagent {
                status: SubagentStatus::Running,
                ..
            } | TranscriptItem::AssistantText {
                streaming: true,
                ..
            } | TranscriptItem::Thinking {
                streaming: true,
                ..
            }
        );
        if !needs_finalize {
            continue;
        }
        // Clones only if another reference is outstanding, so this is not a whole-transcript copy.
        match Arc::make_mut(item) {
            TranscriptItem::Tool { status, .. } => {
                *status = match cause {
                    SubagentFinalizeCause::UserStop => ToolStatus::Cancelled,
                    SubagentFinalizeCause::Crash => ToolStatus::Error,
                }
            }
            TranscriptItem::Subagent { status, .. } => {
                *status = match cause {
                    SubagentFinalizeCause::UserStop => SubagentStatus::Cancelled,
                    SubagentFinalizeCause::Crash => SubagentStatus::Exited,
                }
            }
            TranscriptItem::AssistantText { streaming, .. } => *streaming = false,
            TranscriptItem::Thinking { streaming, .. } => *streaming = false,
            _ => unreachable!("needs_finalize only set for the four variants matched above"),
        }
    }
    transcript
}

/// Pending ops a `PatchCoalescer` is accumulating for the window currently in flight.
struct PendingState {
    /// Set when a `reset` was queued this window; it supersedes upserts queued before it (#778).
    reset_items: Option<Vec<Arc<TranscriptItem>>>,
    /// Ids in first-seen order, so a flush emits upserts deterministically.
    upsert_order: Vec<String>,
    /// Keyed by id: a later upsert in the same window replaces the earlier one (#778).
    upserts: HashMap<String, Box<TranscriptItem>>,
    /// Bumped by `flush_now` so a pending debounce timer can tell it was superseded.
    generation: u64,
    timer_armed: bool,
}

impl PendingState {
    fn new() -> Self {
        Self {
            reset_items: None,
            upsert_order: Vec::new(),
            upserts: HashMap::new(),
            generation: 0,
            timer_armed: false,
        }
    }

    fn enqueue(&mut self, ops: Vec<TranscriptOp>) {
        for op in ops {
            match op {
                TranscriptOp::Reset { items } => {
                    self.reset_items = Some(items);
                    self.upsert_order.clear();
                    self.upserts.clear();
                }
                TranscriptOp::Upsert { item } => {
                    let id = item.id().to_string();
                    if !self.upserts.contains_key(&id) {
                        self.upsert_order.push(id.clone());
                    }
                    self.upserts.insert(id, item);
                }
            }
        }
    }

    /// Takes every queued op out (`reset` first, then upserts in first-seen order).
    fn drain(&mut self) -> Vec<TranscriptOp> {
        let mut ops = Vec::new();
        if let Some(items) = self.reset_items.take() {
            ops.push(TranscriptOp::Reset { items });
        }
        for id in self.upsert_order.drain(..) {
            if let Some(item) = self.upserts.remove(&id) {
                ops.push(TranscriptOp::Upsert { item });
            }
        }
        ops
    }
}

/// Coalesces `transcript:patch` events to at most one per Session per `window` of quiet.
// Same-id upserts merge (last write wins) and a `reset` supersedes earlier ops (#778).
pub struct PatchCoalescer {
    window: Duration,
    flush: Arc<dyn Fn(Vec<TranscriptOp>) + Send + Sync>,
    state: Arc<Mutex<PendingState>>,
}

impl PatchCoalescer {
    pub fn new(window: Duration, flush: Box<dyn Fn(Vec<TranscriptOp>) + Send + Sync>) -> Self {
        Self {
            window,
            flush: Arc::from(flush),
            state: Arc::new(Mutex::new(PendingState::new())),
        }
    }

    /// Queues `ops`, flushing every op queued so far after `window` of quiet.
    pub fn queue(&self, ops: Vec<TranscriptOp>) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.enqueue(ops);
        if state.timer_armed {
            return;
        }
        state.timer_armed = true;
        let generation = state.generation;
        drop(state);

        let state_handle = self.state.clone();
        let flush = self.flush.clone();
        let window = self.window;
        tokio::spawn(async move {
            tokio::time::sleep(window).await;
            let mut state = state_handle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.generation != generation || !state.timer_armed {
                // Superseded by an explicit `flush_now` while this timer was sleeping.
                return;
            }
            state.timer_armed = false;
            let ops = state.drain();
            drop(state);
            if !ops.is_empty() {
                flush(ops);
            }
        });
    }

    /// Emits every op queued so far immediately, cancelling any in-flight debounce timer.
    pub fn flush_now(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.timer_armed = false;
        let ops = state.drain();
        drop(state);
        if !ops.is_empty() {
            (self.flush)(ops);
        }
    }
}
