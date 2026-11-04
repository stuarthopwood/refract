# Feature Specification: Usage view Project labels for worktrees and scratch runs

**Feature Branch**: `feat/1571-lane`
**Created**: 2026-11-04
**Status**: Draft
**Input**: GitHub issue #1571 (`p1`, `bug`, scope `usage`), grilled with Stuart 2026-11-02 and amended the same day (outcomes in the issue body and `docs/PLAN.md`).

## Clarifications

### Session 2026-11-04

All answers come from the issue's grill and amendment blocks, its "Technical notes", and the code on origin/main. Recorded 2026-11-04 from the grill.

- Q: How does a reaped worktree map to its Project? -> A: Each registered Project also matches its worktrees root, `<repo>/../pinion-worktrees/<repoName>/` (the convention in `git::worktrees::worktrees_root`, with the `..` resolved). The longest-first sort in `ProjectIndex` gives the right precedence. No other sibling pattern is generalised. (from grill)
- Q: What about rows already stored? -> A: Recompute `project_label` from each row's stored `cwd` once at startup (the worker's first pass) and again whenever the registry changes (the worker re-reads the registry for every pass and every nudge and relabels when the index differs). Rows are relabelled, never dropped; totals are unchanged. (from grill)
- Q: Scratch and temp runs? -> A: A cwd under `%TEMP%`, `C:\tmp` or `\tmp` (and the `AppData\Local\Temp` form, because Windows may report the 8.3 short temp path) becomes the single label **Other**. (from grill)
- Q: Unregistered worktrees? -> A: Any unmatched cwd with a `pinion-worktrees` path segment is a scratch run and becomes **Other** wherever it lives, including nested paths. (from the amendment)
- Q: Any other unmatched folder? -> A: Keeps its own row, labelled with the folder name (last path component), for example `Second-Brain`. Case duplicates (`c:\Repos\Work\fdb-agentkit` and `C:\Repos\Work\fdb-agentkit`) merge into one row: a relabel pass groups unmatched cwds on `normalise_path` and on the lower-cased folder name, and uses one canonical casing (the smallest string) for the group. (from the grill and amendment)
- Q: Rows with no cwd (OMP encoded session folders)? -> A: Decode the encoded folder and run it through the same matching. OMP encodes a cwd as `--C--Repos-Work-x--` (drive paths), `-tmp-...` (under the temp folder) or `-<path>` (under the home folder). Hyphens in real folder names make the encoding lossy, so a Project matches when its own encoded path equals the folder name or is a hyphen-delimited prefix of it, and the remainder is not a worktrees folder. Unmatched encoded folders classify as Other (temp, `pinion-worktrees`) or take a name from a stored cwd that encodes to the same folder, else the text after the last hyphen. (from the amendment; the encoded-compare mechanism is a lane decision because naive decoding turns `fdb-agentkit` into `fdb\agentkit`)
- Q: Which Usage sections change? -> A: Every section grouped or filtered by Project (By project, Top ten sessions, the Project filter, calls table) because they all read the one stored `project_label`; no query or renderer change. (from grill)
- Q: Where does the relabel pass run? -> A: New `usage/relabel.rs` (`relabel(conn, root, &ProjectIndex)`), moved out of `service.rs` (`relabel_all`), extended to rows with no cwd and to case merging. `root` is needed for the encoded-folder fallback. (lane decision)
- Q: Open questions in the issue? -> A: None.

## User Scenarios & Testing

### User Story 1 - Projects, not paths, in every Usage section (Priority: P1)

A user opens Usage and sees one row per Project, with worktree and scratch runs folded in.

**Independent Test**: Seed usage under a Project's worktrees root, a temp folder, an unregistered `pinion-worktrees` path, a non-Project folder in two casings, and an OMP encoded folder; open Usage and check the By project rows and the Project filter options.

**Acceptance Scenarios**:

1. **Given** a registered Project, **When** a session ran in `<repo>/../pinion-worktrees/<repoName>/<worktree>` (live or reaped), **Then** its usage counts under the Project's name in every section.
2. **Given** a cwd under `%TEMP%` or `C:\tmp`, or any unmatched cwd with a `pinion-worktrees` segment, **Then** it counts under one **Other** row.
3. **Given** an unmatched folder such as `C:\Second-Brain`, **Then** its row is labelled `Second-Brain`, and its case duplicates share that row.
4. **Given** a session file with no cwd in `--C--Repos-Work-fdb.patient.activation--`, **Then** it joins the Project registered at that path.
5. **Given** the registry gains or loses a Project, **When** the next pass or nudge runs, **Then** stored rows move to the new label and the grand total is unchanged.

### Edge Cases

- A sibling folder sharing a name prefix (`proj-two` next to `proj`) does not match `proj`.
- An encoded folder whose remainder begins `worktrees-` is a worktrees root, never a subfolder of the Project, so an unregistered `pinion-worktrees\other` is Other, not the Project.
- A cwd that is empty, or whitespace, falls back to the encoded session folder.
- A folder name differing only by case from a Project name stays its own row (Projects match on path, not name).

## Requirements

- **FR-001**: `ProjectIndex::from_registry` adds `(worktrees_root(repo.path), name)` for each Project, with `..` resolved lexically.
- **FR-002**: `label()` returns the Project name, else `Other` for temp or `pinion-worktrees` cwds, else the last path component of the cwd.
- **FR-003**: Encoded session folders resolve through the same rules (Project by encoded-prefix compare, Other, folder name).
- **FR-004**: `relabel(conn, root, &ProjectIndex)` recomputes every stored row's label from its `cwd` (or encoded folder), merges unmatched case duplicates, and runs on each full pass and whenever the index changes.
- **FR-005**: Totals do not change; the relabel only moves rows between labels.
- **FR-006**: No renderer, IPC or query change.

## Success Criteria

- A scratch data dir with seeded rows shows Project, **Other** and merged folder rows in By project and the Project filter, and the By project total equals the seeded sum.
- Rust tests cover the worktrees root, Other, folder-name, encoded-folder and relabel (totals preserved) cases.

## Assumptions and non-goals

- Rust tests are allowed for this lane (issue note, epic #797 exception); no renderer tests.
- No schema change and no new IPC channel.
- Not generalising worktree roots beyond `pinion-worktrees`.
- An unregistered hyphenated folder reached only through an encoded name, with no stored cwd to learn from, shows its text after the last hyphen (`Brain` for `Second-Brain`); encoding loses the information.
