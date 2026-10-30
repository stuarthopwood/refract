# Analysis: spec 064

Coverage: FR-1 T002; FR-2 T003 and T004; FR-3 to FR-7 T005; FR-8 T006; FR-9 T007; SC-1 to SC-3 are covered by the live check (director) and SC-4 by T008. No FR lacks a task.

Conflicts checked: Ctrl+K versus the Markdown editor's link chord (resolved by the `defaultPrevented` decision); Ctrl+Shift+P is free in `App.tsx` and `MessageInput.tsx`; the palette `role="dialog"` already suppresses the window-level chords through `OVERLAY_OPEN_SELECTOR`; specs 024 (right pane chord), 056 (pause) and 060 (Usage entry) are consumed, not changed.

Risks: the Ctrl+N extraction must keep its behaviour (guards stay in the `App.tsx` handler; only the creation body moves); `App.tsx` stays under 600 lines; the dialog's rows change wording to the registry label (accepted); chord drift between the registry and the old handlers remains possible until slice 2 and is recorded in the spec.

ADR check: shared components only (ADR 0003, `command.tsx` on the existing Dialog); no new IPC; comments are why-only; no tests added (rapid-prototyping phase).
