# Tasks: spec 094

- [x] T1 Rust lookup `readout_pr.rs`, readout wiring, delete `pr_lookup.rs`
- [x] T2 Remove the `pull-request` kind (Rust settings, model.ts, StatusLineSection, ComposerStatusLine, Readouts)
- [x] T3 Shared `SessionPullRequest` type and readout store default
- [x] T4 Pinned panels store, registry descriptors, panels, shell wiring
- [x] T5 Header badges, buttons, issue menu, narrow layout
- [x] T6 Theme tokens and contrast pairs
- [x] T7 Live check `scripts/verify-tauri-094.mjs`
- [x] T8 `pnpm ci:local`
- [x] T9 Six-reviewer gate

## Analysis (2026-10-31)

Every FR maps to a task: FR-1 T1/T3, FR-2 T1, FR-3 T5, FR-4 T4/T5, FR-5 T5, FR-6 T4. Decision 1 maps to T2, decision 10 to T4 (live store), decision 11 to T6. No conflict with ADR 0003: badges use `Badge`, `Button`, `IconButton`, `DropdownMenu`.
