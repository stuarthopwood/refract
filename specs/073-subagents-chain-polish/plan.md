# plan 073

- Renderer: `SubagentChainRow.tsx` card classes on the `CollapsedLine` root (`mt-6 rounded-lg border border-divider bg-card p-1`).
- Docs: `docs/design/components.md` exception line.
- Rust: `omp/transcript/subagent_items.rs` gains `ProgressOutcome`, `classify_progress_status` and `TranscriptState::settle_subagent`; `session/agent/mod.rs` gains `settle_transcript_subagents`; `session/subagents_progress.rs` calls it from the batch, jobs and lifecycle paths and reuses the shared classifier.
- No change to `omp/transcript.rs` size (baselined offender).
