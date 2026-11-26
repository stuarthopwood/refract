// Labels `subagent` items with the synthesised role and goal, read from a lookup and never written (ADR 0013 Q4).
// The lookup is the Session's disk cache, so replaying history or rebuilding a snapshot cannot cost a model call.

use std::sync::{Arc, Mutex, TryLockError};

use super::{TranscriptItem, TranscriptState};

/// The synthesised labels of one card; both are `None` until the call has a synthesis.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubagentLabels {
    pub role: Option<String>,
    pub overall_goal: Option<String>,
}

/// Where the labels come from. Read-only by contract, so the transcript can never trigger a synthesis.
pub trait SynthesisLookup: Send + Sync {
    /// The labels already known for the card at `spec_index` of one `task()` call.
    fn labels(&self, tool_call_id: &str, spec_index: u32) -> SubagentLabels;
}

/// A cache shared with its writer. `try_lock`, so a frame never waits on a write in flight: every
/// writer relabels the transcript after it releases the lock, so a row skipped here is filled then.
impl<T: SynthesisLookup> SynthesisLookup for Mutex<T> {
    fn labels(&self, tool_call_id: &str, spec_index: u32) -> SubagentLabels {
        match self.try_lock() {
            Ok(inner) => inner.labels(tool_call_id, spec_index),
            Err(TryLockError::Poisoned(poisoned)) => {
                poisoned.into_inner().labels(tool_call_id, spec_index)
            }
            Err(TryLockError::WouldBlock) => SubagentLabels::default(),
        }
    }
}

/// Fills in every unlabelled `subagent` item; one already labelled is left alone, because a call's
/// synthesis is written once and the streaming path would otherwise clone the strings on every frame.
fn label_unlabelled(items: &mut [Arc<TranscriptItem>], lookup: &dyn SynthesisLookup) -> bool {
    let mut changed = false;
    for item in items.iter_mut() {
        let TranscriptItem::Subagent {
            tool_call_id,
            spec_index,
            role: None,
            overall_goal: None,
            ..
        } = item.as_ref()
        else {
            continue;
        };
        let labels = lookup.labels(tool_call_id, *spec_index);
        if labels == SubagentLabels::default() {
            continue;
        }
        if let TranscriptItem::Subagent {
            role, overall_goal, ..
        } = Arc::make_mut(item)
        {
            *role = labels.role;
            *overall_goal = labels.overall_goal;
            changed = true;
        }
    }
    changed
}

impl TranscriptState {
    /// Attaches the label source and labels the items already built; `true` if any changed.
    pub fn set_synthesis_lookup(&mut self, lookup: Arc<dyn SynthesisLookup>) -> bool {
        self.synthesis = Some(lookup);
        self.relabel_subagents()
    }

    /// Labels `subagent` items built since the last pass; `true` if any changed.
    pub fn relabel_subagents(&mut self) -> bool {
        match &self.synthesis {
            Some(lookup) => label_unlabelled(&mut self.items, lookup.as_ref()),
            None => false,
        }
    }

    /// Swaps in `next` as the whole transcript, keeping this state's label source: a new or reopened
    /// Conversation shares the Session's cache, and a state built from history has none of its own.
    pub fn replace_keeping_lookup(&mut self, mut next: TranscriptState) {
        next.synthesis = self.synthesis.take();
        next.relabel_subagents();
        *self = next;
    }
}

/// `items` with the labels filled in. Only labelled `subagent` rows get a fresh `Arc`, so a cached
/// history the caller shares is never mutated.
pub fn labelled_copy(
    items: &[Arc<TranscriptItem>],
    lookup: &dyn SynthesisLookup,
) -> Vec<Arc<TranscriptItem>> {
    let mut copy = items.to_vec();
    label_unlabelled(&mut copy, lookup);
    copy
}

#[cfg(test)]
#[path = "synthesis_labels_tests.rs"]
mod tests;
