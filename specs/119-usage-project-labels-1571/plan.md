# Implementation Plan: Usage view Project labels for worktree and scratch cwds

**Spec**: `specs/119-usage-project-labels-1571/spec.md` | **Issue**: #1571

## Technical context

Rust only, `src-tauri/src/usage/` and one call site in `ipc/usage.rs`. Every Usage query groups on the stored `project_label` (`messages`, `tool_calls`, `user_messages`, `session_rollup`, `message_rollup`, `tool_rollup`, `file_offsets`), so fixing the stored label fixes every section and the Project filter. No schema change, no IPC change, no renderer change.

## Design

**`project_label.rs` (labels).**
- `Resolved<'a>`: `Project(&str)`, `Other`, `Folder(String)`; `into_label()` gives the stored string (`OTHER_LABEL = "Other"`).
- `ProjectIndex` gains `temp_roots` and `home` (set from `std::env::temp_dir()`, `C:\tmp`, `\tmp` and `dirs::home_dir()` by `from_pairs`; `with_env` lets tests pin them) and `encoded`, the entries' OMP-encoded keys. It derives `PartialEq` so the worker can tell when the registry changed.
- `from_registry`: for each repository also push `(worktrees_root(path) with ".." resolved, name)`. Reuses `git::worktrees::worktrees_root`; a small `without_parent_dirs` helper resolves `..` because `normalise_path` is purely textual.
- `resolve(cwd)`: `match_cwd`, else scratch (a `pinion-worktrees` segment, a temp root, or the `AppData\Local\Temp` form) -> `Other`, else `Folder(last component)`.
- `resolve_folder(folder)`: OMP encoded names (`--C--Repos-x--` drive form, `-tmp-...` temp form, `-<rel>` home form). Key = lower-cased inner text tagged `d:` or `h:`. A Project matches when its encoded key equals the key or prefixes it at a hyphen and the remainder does not start with `worktrees`. Else `Other` for temp (`h:tmp-`, an encoded temp root) or `pinion-worktrees`, else `Folder(text after the last hyphen)`. Non-encoded names stay as they are.
- `label()` becomes `resolve(cwd)` or `resolve_folder(folder_name_fallback)`, `.into_label()`. Ingest (`ingest.rs:267`) already calls it, so new rows are labelled correctly with no change there.

**`relabel.rs` (new; moved from `service.rs::relabel_all`).**
- `relabel(conn, root, &ProjectIndex) -> rusqlite::Result<()>`: read `session_file, cwd, project_label` from `file_offsets` (all rows, not only those with a cwd); build a map `encoded(normalised cwd) -> Resolved` from rows that have a cwd, used for cwd-less rows before the heuristic `resolve_folder`; resolve every row; canonicalise `Folder` casing (lower-case folder name -> smallest cased string seen); for rows whose label changed, in one transaction call `rollup::relabel_file` and update `file_offsets`. Rollup totals only move between labels.

**`service.rs`.** Remove `relabel_all`; `full_scan` calls `relabel::relabel`. Add `Inner.labelled: Mutex<Option<ProjectIndex>>`; `nudge_one` calls the relabel when the freshly read index differs from the last relabelled one (registry change between scans), and `full_scan` always relabels (also canonicalises case after newly ingested files). `ipc/usage.rs:49` is unchanged: it is the provider both paths already call.

**Tests (allowed, Rust).** `project_label.test.rs`: worktrees root, `..` resolution, Other (temp, `pinion-worktrees`), folder name, encoded folders (Project, hyphenated Project, worktrees remainder, `-tmp-`, home form), existing fallback test updated. New `relabel.test.rs`: seeded rows relabel with totals unchanged, cwd-less row joins its Project, case duplicates merge, registry change moves rows both ways.

**Docs.** `docs/PLAN.md` row for #1571 -> "in review"; `CHANGELOG.md` Unreleased; `specs/060-usage-view/spec.md` note on labels if it describes the fallback.

**Driver.** `scripts/verify-tauri-1571.mjs` modelled on `verify-tauri-1636.mjs`: scratch `REFRACT_DATA_DIR` with a registry Project, seeded session jsonl files (worktree under the worktrees root, `%TEMP%` cwd, OMP encoded folder with no cwd, case-duplicate cwd, `pinion-worktrees` unregistered cwd), open Usage, read By project rows and Project filter options, assert totals equal the seeded sum. Not run here (builds an exe); `node --check` only.

## Files the implementation touches

Rust: `src-tauri/src/usage/project_label.rs`, `project_label.test.rs`, new `relabel.rs` + `relabel.test.rs`, `service.rs`, `mod.rs`.
Docs: `docs/PLAN.md`, `CHANGELOG.md`. Script: `scripts/verify-tauri-1571.mjs`.

## Constitution and repo rules

Files under 600 lines; "why" comments only; no `scripts/file-size-baseline.json` change; no build in this lane (`cargo fmt --check` only).

## Risks

- Cannot compile here: the run worker builds and runs `cargo test`. Risk points: `PartialEq` on `ProjectIndex`, `Path::components` on `..` for Windows verbatim paths, borrowed `Resolved<'a>` lifetimes in `relabel`.
- Encoded-folder matching is a heuristic (hyphen-lossy encoding): a Project `fdb` would also claim an unregistered `fdb-agentkit` encoded folder with no cwd. Longest-first ordering makes a registered `fdb-agentkit` win, and cwd-bearing rows never use this path.
