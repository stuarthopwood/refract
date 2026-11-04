# Analysis: spec 118 (#1589)

Consistency pass over spec.md, plan.md, tasks.md.

- Every FR maps to a task: FR-001 T003, FR-002 T004, FR-003 T007, FR-004/FR-005 T006, FR-006 T007 (debounce only), FR-007 T006/T007.
- Finding 1: the list pane summary is a polite live region; a count change may be announced. Accepted: it is a count, not the list (matches the grill rule).
- Finding 2: `rebuild_from_history` also resolves repos; emission is placed in `record_writes` only, so replay never emits.
- Finding 3: a write to an unregistered repository has no `repositoryId`; the renderer refreshes regardless.
- Finding 4: Rust compile cannot be checked here; the run worker builds. Only `cargo fmt --check` runs in this lane.
- Decision (round 2, search lag): list data comes from `gh search prs`, whose index can lag a merge or close by seconds, so the refresh right after an event may still show the old row. After a burst's refresh each lane arms exactly ONE follow-up quiet refresh ~5 s later (`GITHUB_CHANGED_FOLLOW_UP_MS`); a new event resets it and the follow-up itself arms nothing. This is not polling: no repeating timer, and nothing runs without an event.
- Decision (round 2, race): a quiet refresh never starts while the list's user `refresh` is `loading`; the lane is marked dirty and reruns once after the user fetch lands. Home does the same when `refresh` returns false during a user fetch. Quiet and user fetches share `refreshSequence`, so whichever started last wins and an older response is dropped.
- No open questions.
