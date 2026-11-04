# Tasks: Usage view Project labels for worktree and scratch cwds

**Spec**: `spec.md` | **Plan**: `plan.md` | **Issue**: #1571

## Phase 1: Labelling rules

- [x] T001 `project_label.rs`: `Resolved` (Project, Other, Folder), `OTHER_LABEL`, scratch detection (`pinion-worktrees` segment, `%TEMP%`, `C:\tmp`, `AppData\Local\Temp`).
- [x] T002 `ProjectIndex::from_registry` adds each Project's `pinion-worktrees/<repoName>/` root (`..` resolved).
- [x] T003 Encoded OMP session folders (`--C--Repos-x--`) resolve through each Project's encoded path; scratch folders become Other; others keep a readable name.
- [x] T004 Rust tests in `project_label.test.rs` for worktrees root, dots, Other/temp, folder names, encoded folders, no-cwd fallback.

## Phase 2: Stored rows

- [x] T005 `relabel.rs`: relabel every `file_offsets` row (cwd-less rows borrow a sibling's cwd in the same folder), merge case-duplicate folder names, move rollups with `rollup::relabel_file`; totals unchanged.
- [x] T006 `relabel.test.rs`: relabel to Projects/Other/merged folder without changing totals, registry change moves rows back and forth, second pass is a no-op.
- [x] T007 `service.rs`: relabel on startup, around each full scan and on a registry change before a nudge (`Inner.labelled`); old `relabel_all` removed.

## Phase 3: Verification and docs

- [x] T008 `scripts/verify-tauri-1571.mjs` live driver (syntax-checked only; run by the run worker).
- [x] T009 `CHANGELOG.md` Unreleased entry and `docs/PLAN.md` status line.
- [ ] T010 Main's run worker: `cargo test`, `cargo clippy`, ci-local, live driver.
