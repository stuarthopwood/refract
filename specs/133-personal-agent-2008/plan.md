# Implementation Plan: Personal Agent (single project-less Session)

**Branch**: `feat/2004-personal-agent-model` | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/133-personal-agent-2008/spec.md`

One plan for the epic (#2008). Only the #2004 phase (Phase 1 below) is implemented in the first PR; #2005, #2007 and #2006 converge against this plan. Their sections are design intent grounded in current code and are re-verified when each child starts.

## Summary

Add a `kind` (`project` | `personal`) to the persisted **Session**, make the four repository fields optional only for `personal`, and enforce the singleton and the "cannot archive or delete" rule in Rust. The interface sees a discriminated union so every consumer must handle `personal`. Later children add the launch path (home folder cwd, no **Worktree**), the launcher button above the **Projects** list, and the repo-only empty state. No new storage, process mode or conversation machinery is added: the Personal Agent is an ordinary Session row that a launcher opens.

## Technical Context

**Language/Version**: Rust (Tauri v2 backend, `src-tauri`), TypeScript strict + React (renderer, `src`).

**Primary Dependencies**: existing only (serde, serde_json, tokio; Zustand stores; the shared reusable UI components of ADR 0003). No new dependency.

**Storage**: `registry.json` in the app data folder via `store/registry.rs` (`RegistryStore`, atomic write). One additive field per Session (`kind`); no new file.

**Testing**: no new tests while prototyping (AGENTS.md). Existing Rust test fixtures that build a `Session` literal must change to keep compiling; that is the only test edit. Verification is `pnpm ci:local` plus a live `pnpm verify:tauri` run on a scratch data folder (constitution, Development Workflow).

**Target Platform**: Windows 11 desktop only.

**Project Type**: desktop app (Tauri Rust backend + React renderer).

**Performance Goals**: none; the Personal Agent adds one row to the existing list. Session summaries must not run per-Session git work for a Session with no repository.

**Constraints**: no touched file over 600 lines and no baselined file grows; comments are "why" only; reusable UI components; WCAG 2.1 AA; safe-deletion rules; no push or PR from the spec lane.

**Scale/Scope**: one Personal Agent per installation.

## Constitution Check

*Gate: passes after the recorded amendment (constitution v3.1.0, 2026-11-16, T022, landed in #2005); re-checked after Phase 1 design.*

| Principle | Result |
|-----------|--------|
| I. OMP is the engine, Refract the host: `omp --mode rpc-ui`, one OMP process per Session, "one session per git worktree" (`constitution.md:7-9`) | The Personal Agent is still one Session with one OMP process over `rpc-ui`. "One session per git worktree" no longer holds for it. This is a deliberate, separate constitution amendment (tasks T022) that lands before any launch change in #2005, not a dilution inside this plan. #2004 changes no launch, so the first PR conflicts with nothing. |
| III. Saved-session scan in the worktree's OMP directory, reattach in the session's worktree, every OMP process spawned with the session's own worktree as cwd (`constitution.md:59-77`) | Does not hold for the Personal Agent from #2005: its cwd is the home folder. Amended in constitution v3.1.0 (T022), citing FINDINGS item 66 (T021): omp rebinds its working folder to the OS temp folder when the spawn cwd is its own home, so the launch also passes `--cwd=<home>` (T038). |
| II. RPC wire contract | Unchanged. No new RPC command; `--session-dir` and `switch_session` rules apply to the home-folder cwd exactly as to a worktree cwd (verified live in #2005, OQ-5). |
| IV. Evidence before design | #2005 live-probes omp in a non-repository folder before relying on it (FR-015, OQ-5). |
| V. Tauri security baseline | The renderer gets no new capability; the new Rust handler behaviour is validated server-side. The home folder is resolved in Rust. |
| Development workflow | `pnpm ci:local` and a live scratch-instance check (SC-007); typecheck and build must pass. |

## Project Structure

### Documentation (this feature)

```text
specs/133-personal-agent-2008/
|-- spec.md              # epic spec, clarified
|-- plan.md              # this file
|-- research.md          # decisions and alternatives
|-- data-model.md        # Session kind, field matrix, invariants, state rules
|-- quickstart.md        # live verification recipes per phase
|-- contracts/
|   `-- session-kind.md  # wire shape and error codes
|-- checklists/requirements.md
`-- tasks.md
```

### Source Code (repository root)

Grounded by reading the worktree at origin/main `497ca3f0`. Counts come from `git grep` and are starting points; the compiler is the authoritative list.

```text
src-tauri/src/
|-- store/registry.rs              # Session struct 33-74; add_session 327-372; update_session 401-466; remove_session 471-508; remove_repository 294-325 (repository_id comparison at 306); RegistryStore::open 205-209
|-- store/atomic_json.rs           # read_json_file quarantines an unparseable file and returns the default (12-32)
|-- store/import.rs                # reads s.worktree_path / repository_id / branch (315-347, 389-454)
|-- store/session_tree.rs          # tree maths over registry rows; personal has no parent or children
|-- ipc/mod.rs                     # map_registry_error 228-233 maps RegistryErrorCode via as_str()
|-- ipc/sessions_lifecycle.rs      # list 44, create 48, rename 180, archive 211-255, restore 258, delete 377-494, recreate 497
|-- ipc/sessions_lifecycle/diag.rs # diffStat and reveal worktree
|-- ipc/{git_changes,file_explorer,files,attachments,issues,session_kickoff,advisor_roster}.rs
|-- ipc/pull_requests/{handlers.rs,extra_handlers/list_across.rs}
|-- ipc/repositories.rs            # remove project
|-- session/manager.rs             # summaries 256-348: per-session worktree validity at 293-324
|-- session/agent/launch.rs        # start gate 64-94, cwd 180-182, roster cwd 207
|-- session/readout.rs, readout_touched.rs, github_writes/touched.rs
|-- agent_tools/{sessions_create,sessions_update,...}.rs   # Session tools read repository_id and branch
`-- usage/project_label.rs
src/
|-- shared/model.ts               # Session 33-57; TouchedRef.repositoryId nullable precedent 258-261
|-- shared/ipc.ts                 # SessionSummary 120-138 (`extends Session`, must become an alias over the union)
|-- shared/ipc-issues.ts          # SessionWithKickoff 67
|-- tauri-bridge/index.ts         # sessions.* requests (create 159)
|-- renderer/state/{sessions-store,session-list-store,pull-requests-store,issues-store,pinned-panels-store,token-guard-store,view-store,selection-handoff,init-stores}.ts
|-- renderer/features/sessions/   # SessionList.tsx 38-56, sessionDisplay.tsx, startSessionFromItem.ts, startSessionRequest.ts, createdSessionAnnouncement.ts, useWorktreeActions.ts, SessionDetailsCard.tsx, ...
|-- renderer/features/{chat,pull-requests,issues,right-pane,profile,home,palette,settings}/  # worktreePath / repositoryId readers
`-- renderer/components/ProjectListPane.tsx
docs/PLAN.md, docs/spike/FINDINGS.md, .specify/memory/constitution.md   # doc updates per FR-027
```

**Structure Decision**: extend the existing Session row; no new module for the data model. Small helpers live next to `Session` in `registry.rs`; if that file nears its 600-line cap, the helpers and their rules move to a sibling `store/session_kind.rs`. The interface union lives in `src/shared/model.ts` (split into `model-session.ts` only if it would push the file over the cap).

## Phase 0: Research

See [research.md](research.md). All design choices are settled by the grill; research records the alternatives rejected and the code facts that decide them.

## Phase 1: Design and contracts

See [data-model.md](data-model.md) and [contracts/session-kind.md](contracts/session-kind.md); live recipes in [quickstart.md](quickstart.md).

### Child phases

**#2004 data model (this PR).**

- Rust `Session` gets `kind: SessionKind` (`#[serde(default)]`, default `project`) and `repository_id`, `branch`, `base_branch`, `worktree_path` become `Option<String>`, serialised as `null` when absent so the wire shape is a clean union. An old registry has no `kind`, deserialises as `project`, and every Project Session serialises byte-for-byte with the same repository fields (plus `kind: "project"`).
- `Session::project_binding()` returns the four fields together or `None`; a consumer that needs a repository cannot read one without handling `None`. Behaviour-neutral rule for existing consumers: for `project` Sessions nothing changes; for `personal` they skip or return the existing not-found or empty result, never panic or log an error.
- Invariants live in `RegistryStore` and cannot be bypassed by a caller: `add_session` rejects a second `personal` and rejects a `project` row missing any field; `add_session` for `personal` skips the Project, worktree-path and branch checks; `update_session` rejects `archived_at: Some(Some(_))` on `personal`; `remove_session` rejects `personal`. `RegistryStore::open` treats a `project` row with a missing field exactly as a malformed file today (quarantine and default, `atomic_json.rs:25-31`); two `personal` rows on disk load, keep the earliest and log a warning (OQ-3).
- Two new `RegistryErrorCode` values: `personal-agent-exists` and `personal-agent-protected`, mapped by the existing `map_registry_error` and added to the wire code list in `ipc/mod.rs`. The `sessions.archive` and `sessions.delete` handlers check up front, before stopping the agent or touching a watcher, so a refused request has no side effects (the archive handler shuts the agent down at `sessions_lifecycle.rs:229-233` before it patches).
- `src/shared/model.ts` defines `ProjectSession` and `PersonalSession` and `type Session = ProjectSession | PersonalSession`, discriminated on `kind`. `SessionSummary` becomes `Session & { ...runtime fields }` because an interface cannot extend a union. Consumers fix their compile errors with the minimal behaviour-neutral handling above.
- No rendered surface changes; no new user-visible text.

**#2005 create and launch.**

- A handler (no repository or branch input) returns the existing `personal` Session or creates it with the default name "My Agent", `session_dir` unset, all repository fields null, no worktree (contrast `sessions_lifecycle.rs:47-90` which creates one unconditionally).
- Launch: the start gate at `launch.rs:64-94` is skipped for `personal`; the agent cwd and roster cwd at `launch.rs:181` and `:207` become the home folder resolved on every launch (home resolved in Rust via the existing platform helper; precedent for a non-repo cwd: `ipc/readiness.rs:300-301`, `omp/login_providers.rs:66-67`). A missing home folder fails the launch visibly (OQ-4).
- Docs: constitution Principle I and III amendment (version bump per its governance), FINDINGS item for the omp non-repository probe (next free item), `CONTEXT.md` already has the term.

**#2007 repo-only empty state.**

- Rust handlers that take a Session id and need a worktree return a typed `no-repository` result for `personal` (not logged as an error): `git_changes`, `file_explorer`, `files`, `diag` (diffStat, reveal), `pull_requests`, `issues`, `session_kickoff`, `sessions_recreate_worktree`. Add `no-repository` to `IPC_ERROR_CODES` in `src-tauri/src/ipc/mod.rs` and the mirror in `src/shared/ipc.ts`.
- Renderer: the git changes panel, file explorer, PR and diff views gate on `kind`, make no backend call, and show one shared empty state built on the existing `Empty` primitive (title "No repository"; body "The Personal Agent isn't linked to a Project, so there are no changes, files, or pull requests to show."). Worktree actions are removed from the Personal Agent's menus, not disabled; archive and delete show disabled with the reason.

**#2006 launcher button.**

- `SessionList.tsx` renders, from the top: launcher button, divider, "Projects" heading, then the existing project groups; the `personal` Session is filtered out of the group data source. Built from the shared reusable components. State on the button reuses the Session row's status mapping (`sessionDisplay.tsx`).

## Verification

- Every phase: `pnpm ci:local`; no file over 600 lines.
- #2004 live: `pnpm verify:tauri` (or a scratch-instance script in `scripts/`) on an isolated data folder seeded with a pre-feature `registry.json`: all Sessions load as `project` and round-trip unchanged (SC-001); a `personal` row can be added once, a second is refused, archive and delete are refused (SC-002). Isolation per the Refract scratch-instance skills.
- #2005 live: call the create-or-open IPC over CDP (no UI entry point until #2006); first launch with no worktree on disk, agent cwd is the home folder, a reply arrives (SC-003, SC-004).
- #2006 and #2007 live: CDP check of layout, states and the empty state with an empty app log (SC-005).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Constitution Principle I "one session per git worktree" and III "cwd is the session's own worktree" do not hold for the Personal Agent | The feature is a Session with no repository; its agent must run somewhere real: the home folder (Stuart grill 2026-11-16, decision 5) | A scratch Project or a fake worktree contradicts "not linked to a project or repo" and would pollute the Project list (FR-015 forbids a fake repository) |
| Optional repository fields on a flat Rust struct instead of a Rust enum | 60+ existing Rust and test sites read these fields as plain `String`; `Option` plus `project_binding()` makes each site a compile error without rewriting the persisted shape | A Rust enum with a hand-written serde tag changes the on-disk layout and every test fixture for no extra safety |
