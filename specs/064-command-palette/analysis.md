# Analysis: spec 064

Coverage: FR-1 T002; FR-2 T003 and T004; FR-3 to FR-7 T005; FR-8 T006; FR-9 T007; SC-1 to SC-3 are covered by the live check (director) and SC-4 by T008. No FR lacks a task.

Conflicts checked: Ctrl+K versus the Markdown editor's link chord (resolved by the `defaultPrevented` decision); Ctrl+Shift+P is free in `App.tsx` and `MessageInput.tsx`; the palette `role="dialog"` already suppresses the window-level chords through `OVERLAY_OPEN_SELECTOR`; specs 024 (right pane chord), 056 (pause) and 060 (Usage entry) are consumed, not changed.

Risks: the Ctrl+N extraction must keep its behaviour (guards stay in the `App.tsx` handler; only the creation body moves); `App.tsx` stays under 600 lines; the dialog's rows change wording to the registry label (accepted); chord drift between the registry and the old handlers remains possible until slice 2 and is recorded in the spec.

ADR check: shared components only (ADR 0003, `command.tsx` on the existing Dialog); no new IPC; comments are why-only; no tests added (rapid-prototyping phase).

## Slice 2

Coverage: FR-10 T010; FR-11 and FR-12 T009; FR-13 and FR-14 T011; FR-15 T012; FR-16 needs no task (no Rust change); FR-17 to FR-19 T013; FR-20 T014; SC-5 to SC-9 T015. No FR lacks a task.

Conflicts: the dispatcher must not break the Markdown editor's Ctrl+K link (it does not own Ctrl+K; the palette hook does); `OVERLAY_OPEN_SELECTOR` still suppresses chords while a dialog is open; Ctrl+Shift+X and Ctrl+Shift+B live outside `App.tsx` today and move into the dispatcher only if that keeps their guards.

Risks: `App.tsx` handlers carry guards that must move intact into `when()`; the global `contextmenu` block must not hit editable fields or Radix triggers; file-size cap on `RepositoryGroup.tsx` and `App.tsx`.

ADR check: shared menu primitives extended with props (ADR 0003); no new IPC; why-only comments; no tests added.
