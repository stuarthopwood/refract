# plan 073

- Renderer: `SubagentChainRow.tsx` card classes on the `CollapsedLine` root (`mt-6 rounded-lg border border-divider bg-card p-1`).
- Docs: `docs/design/components.md` exception line.
- Rust: `omp/transcript/subagent_items.rs` gains `ProgressOutcome`, `classify_progress_status` and `TranscriptState::settle_subagent`; `session/agent/mod.rs` gains `settle_transcript_subagents`; `session/subagents_progress.rs` calls it from the batch, jobs and lifecycle paths and reuses the shared classifier.
- No change to `omp/transcript.rs` size (baselined offender).
- #1623: `apply_batch_task_result` keeps a non-error end Running when its progress entry maps to Running; `omp/transcript/subagent_items.rs` gains `settle_unsettled_history_subagents`, called from `settle_interrupted_tool_rows_items` in `transcript.rs` (one call, no size change beyond that). Tests in `omp/transcript/subagent_items_tests.rs`. No renderer or IPC change.
- #1622: `SpineList.tsx` gains an opt-in `elbows` prop (context to `SpineItem`, decorative border tick); `CollapsedLine.tsx` exports the `h-5 w-4` icon-slot class; `ChainStageLine.tsx` becomes an `items-center` Stage row with its agents in a nested elbowed `SpineList`; `SubagentChainRow.tsx` turns elbows on for the Stage list. Renderer only; no IPC change.
