// Port of `src/main/omp/transcriptDiff.ts` and `patchCoalescer.ts` (tasks.md T021).
//
// `diff_transcript` deliberately deviates from the TS source in two ways, both documented at the
// call site below: change detection is by `Arc` POINTER IDENTITY (`Arc::ptr_eq`), the same
// identity rule the TS source itself uses (`transcript.rs`'s own helpers only ever wrap a
// genuinely new value in a fresh `Arc`, mirroring `replaceMessageItems` preserving the reference
// of any item it did not touch) -- and the diff itself is a true O(n) pass via an id->item map
// over `prev` (issue #776) rather than the TS version's repeated `Array.prototype.find` (O(n*m)).
// See `transcript.rs`'s own header comment for why `Arc<TranscriptItem>` (not a plain value, and
// not `PartialEq`) is the live transcript's storage type (performance finding, 2026-10-13).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::transcript::{SubagentStatus, ToolStatus, TranscriptItem};

/// Wire-identical to `src/shared/ipc.ts`'s `TranscriptOp` (`{ op: 'upsert', item }` or
/// `{ op: 'reset', items }`). `Upsert`'s payload is boxed (clippy `large_enum_variant`):
/// `TranscriptItem` is a large enum (the `Tool`/`Subagent` variants carry a dozen-odd fields), so
/// an un-boxed `Upsert { item }` would make every `TranscriptOp` -- including the much smaller
/// `Reset`, whose `Vec` is a fixed-size pointer/len/cap triple regardless of content -- pay that
/// size.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum TranscriptOp {
    Reset { items: Vec<TranscriptItem> },
    Upsert { item: Box<TranscriptItem> },
}

/// Builds the `TranscriptOp`s that bring a subscriber from `prev` to `next`. Port of
/// `diffTranscript`; if any item present in `prev` is gone from `next` (no `TranscriptOp` models
/// deletion), the whole snapshot is resent as a `reset`, exactly like the TS source. Compares by
/// `Arc::ptr_eq`: every `apply_frame` helper upstream only ever rewraps an item in a fresh `Arc`
/// (`Arc::make_mut`'s own clone-on-write, or a freshly built item) when it actually changed the
/// value, so a pointer mismatch is a precise, O(1)-per-item "changed" signal -- cheap regardless
/// of transcript size, unlike a full value compare, so diffing stays proportional to what changed
/// instead of to the whole transcript (performance finding, 2026-10-13).
pub fn diff_transcript(prev: &[Arc<TranscriptItem>], next: &[Arc<TranscriptItem>]) -> Vec<TranscriptOp> {
    if prev.is_empty() {
        return if next.is_empty() {
            Vec::new()
        } else {
            vec![TranscriptOp::Reset { items: next.iter().map(|item| (**item).clone()).collect() }]
        };
    }
    let next_ids: HashSet<&str> = next.iter().map(|item| item.id()).collect();
    let any_removed = prev.iter().any(|item| !next_ids.contains(item.id()));
    if any_removed {
        return vec![TranscriptOp::Reset { items: next.iter().map(|item| (**item).clone()).collect() }];
    }
    let prev_by_id: HashMap<&str, &Arc<TranscriptItem>> = prev.iter().map(|item| (item.id(), item)).collect();
    let mut ops = Vec::new();
    for item in next {
        match prev_by_id.get(item.id()) {
            Some(before) if Arc::ptr_eq(before, item) => {}
            _ => ops.push(TranscriptOp::Upsert { item: Box::new((**item).clone()) }),
        }
    }
    ops
}

/// `start()`/`restart()` each fetch full history with `get_messages` and would otherwise
/// flat-replace the live transcript with it, silently dropping anything a live frame appended
/// while that round trip was in flight. Port of `mergeLiveTranscript`: keeps `history` as-is and
/// appends only live items history can never contain -- an UNRESOLVED `request`, or a still-
/// in-flight `tool`/`subagent` (`status: 'running'`) or streaming `assistant-text`/`thinking`.
pub fn merge_history_with_live(history: &[Arc<TranscriptItem>], live: &[Arc<TranscriptItem>]) -> Vec<Arc<TranscriptItem>> {
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
    let extra: Vec<Arc<TranscriptItem>> = live.iter().filter(|item| is_unpersisted(item)).cloned().collect();
    if extra.is_empty() {
        history.to_vec()
    } else {
        history.iter().cloned().chain(extra).collect()
    }
}

/// Settles any item the process that was updating it will now never finish: a still-`running`
/// tool/subagent call becomes `status: 'error'`, and streaming assistant-text/thinking becomes
/// `streaming: false`. Port of `finalizeLiveTranscript`. Without this, a crash, a `stop()`, or a
/// mode-change `restart()` leaves those items spinning in the UI forever, and (per the TS doc
/// comment) `merge_history_with_live`'s `is_unpersisted` check would keep mistaking them for
/// still-live and re-append them onto every later `launch()`'s fresh history.
pub fn finalize_live_transcript(mut transcript: Vec<Arc<TranscriptItem>>) -> Vec<Arc<TranscriptItem>> {
    for item in transcript.iter_mut() {
        let needs_finalize = matches!(
            item.as_ref(),
            TranscriptItem::Tool { status: ToolStatus::Running, .. }
                | TranscriptItem::Subagent { status: SubagentStatus::Running, .. }
                | TranscriptItem::AssistantText { streaming: true, .. }
                | TranscriptItem::Thinking { streaming: true, .. }
        );
        if !needs_finalize {
            continue;
        }
        // `Arc::make_mut` clones the value only when another reference is still outstanding (the
        // common case while this runs: nothing else holds these items), so this stays O(1)
        // allocation-wise per touched item, not a whole-transcript copy.
        match Arc::make_mut(item) {
            TranscriptItem::Tool { status, .. } => *status = ToolStatus::Error,
            TranscriptItem::Subagent { status, .. } => *status = SubagentStatus::Error,
            TranscriptItem::AssistantText { streaming, .. } => *streaming = false,
            TranscriptItem::Thinking { streaming, .. } => *streaming = false,
            _ => unreachable!("needs_finalize only set for the four variants matched above"),
        }
    }
    transcript
}

/// Pending ops a `PatchCoalescer` is accumulating for the window currently in flight.
struct PendingState {
    /// Set when a `reset` was queued this window; supersedes (and clears) every upsert queued
    /// before it (issue #778) -- any upsert queued AFTER it is still tracked separately below and
    /// still emitted on top of it, since it represents a later, incremental change.
    reset_items: Option<Vec<TranscriptItem>>,
    /// Ids in first-seen order, so a flush emits upserts in a stable, deterministic sequence.
    upsert_order: Vec<String>,
    /// Keyed by id: a second `upsert` for the same id queued in the same window replaces the
    /// first rather than both being sent (issue #778, "last write wins").
    upserts: HashMap<String, Box<TranscriptItem>>,
    /// Bumped by `flush_now`; a scheduled debounce timer checks this to tell whether it has
    /// already been superseded by an explicit flush before it fired.
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

    /// Takes every queued op out, in emission order (`reset` first, if any, then upserts in
    /// first-seen order), leaving the pending state empty.
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

/// Coalesces `transcript:patch` events to at most one per Session per `window` of quiet (default
/// 50 ms, contracts/ipc.md `transcript:patch`). Port of `PatchCoalescer`
/// (`src/main/omp/patchCoalescer.ts`), extended per issue #778 to merge same-id upserts within a
/// window (last write wins) and to let a `reset` supersede everything queued before it, rather
/// than the TS version's plain `pendingOps.push(...ops)` (which relied on the renderer applying
/// every queued op in order and converging on the same final state, just with more wire traffic).
/// The TS class's separate `reset(items)`/`clear()` methods are not part of this facade; `queue`
/// already accepts a `TranscriptOp::Reset` like any other op, and `flush_now` covers "emit
/// whatever is pending right now, cancelling the debounce timer".
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
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
            let mut state = state_handle.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.timer_armed = false;
        let ops = state.drain();
        drop(state);
        if !ops.is_empty() {
            (self.flush)(ops);
        }
    }
}
