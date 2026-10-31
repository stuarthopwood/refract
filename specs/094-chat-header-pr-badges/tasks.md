# Tasks: spec 094

- [ ] T1 Rust lookup `readout_pr.rs`, readout wiring, delete `pr_lookup.rs`
- [ ] T2 Remove the `pull-request` kind (Rust settings, model.ts, StatusLineSection, ComposerStatusLine, Readouts)
- [ ] T3 Shared `SessionPullRequest` type and readout store default
- [ ] T4 Pinned panels store, registry descriptors, panels, shell wiring
- [ ] T5 Header badges, buttons, issue menu, narrow layout
- [ ] T6 Theme tokens and contrast pairs
- [ ] T7 Live check `scripts/verify-tauri-094.mjs`
- [ ] T8 `pnpm ci:local`
- [ ] T9 Six-reviewer gate

## Analysis (2026-10-31)

Every FR maps to a task: FR-1 T1/T3, FR-2 T1, FR-3 T5, FR-4 T4/T5, FR-5 T5, FR-6 T4. Decision 1 maps to T2, decision 10 to T4 (live store), decision 11 to T6. No conflict with ADR 0003: badges use `Badge`, `Button`, `IconButton`, `DropdownMenu`.
