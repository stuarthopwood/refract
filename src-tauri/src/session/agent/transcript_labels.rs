// Gives the Session's transcript its synthesis label source, and refreshes its `subagent` rows when a
// synthesis lands after the row exists (ADR 0013 Q4). The transcript only ever reads the cache.

use std::sync::Arc;

use super::SessionAgent;
use crate::omp::diff::diff_transcript;
use crate::omp::transcript::synthesis_labels::SynthesisLookup;
use crate::omp::transcript::TranscriptState;

impl SessionAgent {
    /// Attaches the label source and labels the rows already built, so history replay carries the cache.
    pub(crate) async fn attach_synthesis_lookup(&self, lookup: Arc<dyn SynthesisLookup>) {
        self.update_transcript_labels(|transcript| {
            transcript.set_synthesis_lookup(lookup);
        })
        .await;
    }

    /// Fills the labels a new cache entry just made available on rows built before it landed.
    pub(crate) async fn relabel_transcript_subagents(&self) {
        self.update_transcript_labels(|transcript| {
            transcript.relabel_subagents();
        })
        .await;
    }

    /// Runs `update` and queues the resulting diff under the same lock hold, like every live append.
    async fn update_transcript_labels(&self, update: impl FnOnce(&mut TranscriptState)) {
        let mut state = self.state.lock().await;
        let before = state.transcript.snapshot();
        update(&mut state.transcript);
        let ops = diff_transcript(&before, state.transcript.items());
        if !ops.is_empty() {
            self.coalescer.queue(ops);
        }
    }
}
