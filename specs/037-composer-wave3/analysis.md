# Analysis: Composer (wave 3)

Cross-check of `spec.md`, `plan.md` and `tasks.md` (2026-10-29).

- Coverage: every FR maps to a task (FR-001 T2, FR-002 T3, FR-003 T5, FR-004 T6, FR-005 T1, FR-006 T7, FR-007 T8 and T9, FR-008 T11, FR-009 T12, FR-010 T15, FR-011 T13 and T14, FR-012 T4). No orphan task.
- Ordering risk: #496's Ask and remember (T8) needs T7 (OMP maps unknown labels to deny). T8 must not ship selectable without T7.
- File collision risk: `MessageInput.tsx` (A then B only), `ChatPane.tsx` (B mount, D banner, E gap: serial), `globals.css` (A tokens, E shimmer vars: separate regions).
- Cap risk: `MessageInput.tsx` is over 600 lines; T1 and T5 shrink it, nothing grows it. `store/settings.rs` is 588 of 600: T8 and T13 use sibling files.
- Constitution: Principle V (Tauri security) applies to the new Rust commands; no new tests while prototyping.
- Open item: T10's probe decides how much of #712 is feasible without a new OMP frame; if it cannot be done truthfully, the banner shows only agents the probe confirms and the gap is filed as a follow-up.
