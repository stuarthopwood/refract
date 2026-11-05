# spec 073: Subagents chain polish (#1436, #1437)

A card around the in-chat Subagents chain (renderer) and one status pipeline for chain rows and the Agents pill (Rust session layer). No IPC change.

## Clarifications

### Session 2026-10-30 (self-grill, Skippy delegated by Stuart; both issues already carry the decisions)

- Q: Which surface gets the card? [Decided, #1436] The multi-Stage `SubagentChainRow` only; the right-pane tree and a single Stage stay unboxed.
- Q: Card tokens? [Decided] Existing `rounded-lg border-divider bg-card` with `p-1` around the unchanged `CollapsedLine`; no new token, no status colour, no new animation.
- Q: Where does the zero-box exception live? [Decided] A dated fourth exception in `docs/design/components.md` "Cards and boxes".
- Q: How does the chain row get its status? [Decided, #1437] The transcript `subagent` item settles from the same signals that settle the Rust summaries (progress batch, jobs list, lifecycle frame); the renderer gets no override.
- Q: One status table? [Decided] `classify_progress_status` in `omp/transcript/subagent_items.rs` is the only word-to-outcome map; the summaries, the `task` result and the async job result all use it. Behaviour change: `started`, `queued`, `spawned` and empty words read as running on the transcript side too.
- Q: Process exit? [Decided] Unchanged: exit still settles through the existing finalize path; only Finished, Failed and Cancelled outcomes are mirrored to the transcript.

### Session 2026-11-05 (amendment, #1623, grilled 2026-11-03 by Stuart)

- Q: A background `task` call ends at spawn with progress entries still running. What does the item do? [Decided] It stays Running. `apply_batch_task_result` no longer turns a Running progress entry into the success fallback; a later jobs or lifecycle signal settles it through `settle_subagent` with a real duration.
- Q: A synchronous `task` end with no progress entry for an index? [Decided] Unchanged: settles Done. Error and Stop paths (#563, #911) are unchanged.
- Q: History replay of a background item that never gets a settle signal? [Decided] Replay applies later `wait` jobs and async-result messages first (history carries both). Any item still Running after replay belongs to a dead process, so it settles Done with no duration; it must not spin forever.

## Functional requirements

- FR-1 (#1436): A chain of two or more Stages renders in a neutral card; collapse, Spine, header and actions are unchanged.
- FR-2 (#1437): When a summary leaves running, the matching transcript item (`toolCallId`, `specIndex`) settles with the same outcome and a duration, and the patch reaches the renderer. A settled item never moves back.
- FR-3 (#1437): A single shared function maps an OMP status word to an outcome.
- FR-4 (#1623): A non-error `task` end whose progress entry reads running leaves the `subagent` item Running (job id still stored); it settles later via jobs or lifecycle with `durationMs`.
- FR-5 (#1623): History replay settles a still-Running `subagent` item Done once all later job results are applied.

## Success criteria

- SC-1: Live check shows the card and, with a lifecycle frame that settles before any `task` result, the chain row settles with the pill.
- SC-2: `pnpm ci:local` passes.
- SC-3: No new tests (rapid-prototyping phase).
- SC-4 (#1623): Rust tests cover the async end, the later `wait` settle, the sync end, and history replay (the SC-3 no-new-tests rule is lifted for Rust, epic #797).
