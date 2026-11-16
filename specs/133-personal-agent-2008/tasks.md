---

description: "Task list for Personal Agent epic #2008, grouped per child issue"
---

# Tasks: Personal Agent (single project-less Session)

**Input**: Design documents from `/specs/133-personal-agent-2008/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/session-kind.md, quickstart.md

**Tests**: No test-writing tasks. AGENTS.md forbids new tests while prototyping and the spec asks for none. The only test-file edits allowed are existing Rust fixtures that must change to keep compiling (T011).

**Organization**: One phase per child issue, in dependency order: #2004, then #2005, then #2007 (depends only on #2004), then #2006 (depends on #2005). Only the #2004 phase is implemented in the first PR; later phases are converged against this spec when each child starts.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 = #2004, US2 = #2005, US4 = #2007, US3 = #2006 (numbers from spec.md)
- Rust paths are under `src-tauri/src/`; renderer paths under `src/`. Line numbers are starting points; the compiler is the authoritative list of consumers.

## Phase 1: Setup

- [X] T001 Confirm the branch builds clean before any edit (`pnpm ci:local`), and copy a pre-feature `registry.json` (Sessions without `kind`, at least one Child Session and one archived Session) to `C:/Users/shopwood/AppData/Local/Temp/scratch/lane-2004/registry.json` for the live check in T020; remove it at the end.

**Checkpoint**: baseline green.

---

## Phase 2: #2004 Data model (User Story 1, P1) - first PR

**Goal**: the Session record can describe a project-less Session, refuses a second one and refuses archive and delete of it, while every Project Session and every old registry is unchanged and no rendered surface changes.

**Independent Test**: quickstart.md section "#2004 data model": old registry loads as all `project`; second `personal` refused; archive and delete refused; app log clean.

### Rust model and invariants

- [X] T002 [US1] In `store/registry.rs` add `enum SessionKind { Project, Personal }` (`#[serde(rename_all = "lowercase")]`, `Default` is `Project`) and `pub kind: SessionKind` on `Session` with `#[serde(default)]`, so a registry without `kind` loads every row as `project` (FR-001, FR-004). Always serialised.
- [X] T003 [US1] In `store/registry.rs` change `repository_id`, `branch`, `base_branch`, `worktree_path` on `Session` to `Option<String>` with `#[serde(default)]`, serialised as `null` when `None` (no `skip_serializing_if`); add `Session::is_personal()` and `Session::project_binding() -> Option<ProjectBinding<'_>>` returning the four values together (data-model.md). Keep the file under 600 lines: if it would exceed the cap, put `SessionKind` and the helpers in a new `store/session_kind.rs` and re-export.
- [X] T004 [US1] In `store/registry.rs` add `RegistryErrorCode::PersonalAgentExists` (`"personal-agent-exists"`) and `PersonalAgentProtected` (`"personal-agent-protected"`) to the enum and `as_str()`; add both strings to the accepted wire code list in `ipc/mod.rs` (the list near `:238-278`) so `map_registry_error` (`ipc/mod.rs:228-233`) passes them through unchanged.
- [X] T005 [US1] In `store/registry.rs` `add_session` (`:327`): for `project`, refuse a row with any of the four fields `None` and keep the existing unknown-Project, worktree-path and branch checks; for `personal`, skip those three checks (no Project needed, FR-005), require the four fields `None`, and refuse a second `personal` with `PersonalAgentExists` leaving the registry unchanged (FR-002, FR-003).
- [X] T006 [US1] In `store/registry.rs` refuse `PersonalAgentProtected` in `update_session` (`:401`) when the patch sets `archived_at: Some(Some(_))` on a `personal` row, and in `remove_session` (`:471`) for a `personal` row (FR-006); every other patch (rename, activity, model, pause, conversation) stays accepted.
- [X] T007 [US1] In `store/registry.rs` make `remove_repository` (`:294`, comparison near `:306`) compare the optional `repository_id` so a `personal` Session (`None`) never matches and a Project removal never touches it.
- [X] T008 [US1] In `store/registry.rs` `RegistryStore::open` (`:205`): after `read_json_file`, validate rows. A `project` row missing a field is handled like a malformed file today (quarantine via the same path as `store/atomic_json.rs:25-31`, then the default registry), never reinterpreted as `personal`. If two `personal` rows are present, keep the earliest by `created_at`, log a warning naming the others, delete nothing (OQ-3 interim).
- [X] T009 [US1] In `ipc/sessions_lifecycle.rs` make `sessions_archive` (`:211`) and `sessions_delete` (`:377`) look the Session up first and return `IpcError::new("personal-agent-protected", ...)` for a `personal` row before any side effect (the archive path stops the agent and clears watchers before patching, `:221-248`; delete resolves the repository at `:407-410`). The refusal message says the Personal Agent cannot be archived or deleted.

### TypeScript mirror

- [X] T010 [P] [US1] In `src/shared/model.ts` (`:33-57`) split the Session into `SessionBase`, `ProjectSession` (`kind: 'project'`, the four fields `string`) and `PersonalSession` (`kind: 'personal'`, the four fields `null`), and export `type Session = ProjectSession | PersonalSession`. In `src/shared/ipc.ts` (`:120`) turn `SessionSummary` from `interface ... extends Session` into `type SessionSummary = Session & {...}` keeping every runtime field; adjust `SessionWithKickoff` in `src/shared/ipc-issues.ts:67` likewise. If `model.ts` would exceed 600 lines, put the Session types in `src/shared/model-session.ts` and re-export. Add `personal-agent-exists` and `personal-agent-protected` to the IPC error-code union where the other codes are declared.

### Fix every consumer, behaviour-neutral

Rule for T011 to T016: for `project` Sessions the code path and output are byte-identical to today; for `personal` the consumer skips, or returns the existing not-found or empty result; no panic, no error log, no new user-visible text or new surface (FR-008). Use `project_binding()` (Rust) or a narrow on `kind` (TS); never `unwrap()` the options.

- [X] T011 [P] [US1] Fix Rust compile errors in the store and session layers: `store/import.rs` (`:315-347`, `:389-454`), `store/session_tree.rs`, `session/manager.rs` (summaries `:256-348`, worktree validity `:293-324`: a `personal` row reports no per-Session git or worktree check), `session/agent/launch.rs` (`:64-94`, `:180-182`, `:207`: a `personal` Session is refused launch with a clear "not launchable yet" error until #2005, never a panic), `session/readout.rs`, `session/readout_touched.rs`, `session/github_writes/touched.rs`, `usage/project_label.rs`, `git/worktree_delete_check.rs`, `git/worktree_validity.rs`.
- [X] T012 [P] [US1] Fix Rust compile errors in IPC handlers: `ipc/git_changes.rs`, `ipc/file_explorer.rs`, `ipc/files.rs`, `ipc/attachments.rs`, `ipc/issues.rs`, `ipc/session_kickoff.rs`, `ipc/advisor_roster.rs`, `ipc/repositories.rs`, `ipc/pull_requests/handlers.rs`, `ipc/pull_requests/extra_handlers/list_across.rs`, `ipc/sessions_lifecycle.rs` (create `:48`, rename `:180`, restore `:258`, recreate `:497`), `ipc/sessions_lifecycle/diag.rs`, `ipc/sessions_lifecycle/delete_in_flight.rs`. Handlers that need a repository return the existing not-found or empty result for `personal` (OQ-1/FR-024 interim; the explicit not-applicable contract is #2007).
- [X] T013 [P] [US1] Fix Rust compile errors in the agent Session tools: `agent_tools/sessions_create.rs`, `agent_tools/sessions_update.rs`, and any other `agent_tools/` reader the compiler flags. Interim (OQ-1): Project-scoped tools do not list or act on a `personal` Session and it cannot be a parent; a `personal` caller or target gets the tool's existing "not found" or "invalid" result.
- [X] T014 [US1] Update existing Rust test fixtures that build a `Session` literal so they compile (`kind: SessionKind::Project`, `Some(..)` fields) without adding cases: `store/registry_tests.rs`, `ipc/sessions_lifecycle_gate_tests.rs`, `agent_tools/sessions_create.test.rs`, `agent_tools/sessions_update.test.rs`, `ipc/session_kickoff.rs`, and any other literal `cargo check --tests` flags. No new test functions.
- [X] T015 [P] [US1] Fix TypeScript compile errors in state and shared code: `src/renderer/state/sessions-store.ts`, `selection-handoff.ts`, `pinned-panels-store.ts`, `view-store.ts`, `session-list-store.ts`, `pull-requests-store.ts`, `issues-store.ts`, `token-guard-store.ts`, `src/shared/github.ts`, `src/shared/model-git-changes.ts`, `src/tauri-bridge/index.ts`, `src/renderer/lib/linkify.ts`, `src/renderer/lib/defaultRepository.ts`. A `personal` Session yields no repository: filters and selectors skip it.
- [X] T016 [P] [US1] Fix TypeScript compile errors in session features: `src/renderer/features/sessions/SessionList.tsx` and `src/renderer/components/ProjectListPane.tsx` (the `personal` Session is excluded from the project groups so the visible list is unchanged until #2006), `sessionDisplay.tsx`, `createdSessionAnnouncement.ts` (`Pick<Session, 'repositoryId'>` needs the union), `startSessionFromItem.ts`, `startSessionRequest.ts`, `newSessionInFocusedPane.ts`, `useSessionRowActions.ts`, `useWorktreeActions.ts`, `SessionDetailsCard.tsx`, `ArchivedGroup.tsx`, `NewSessionDialog.tsx`, `RemoveRepositoryDialog.tsx`.
- [X] T017 [P] [US1] Fix TypeScript compile errors in the remaining features: `src/renderer/features/chat/` (`ComposerBranchLabel.tsx`, `ItemRefLink.tsx`, `Markdown.tsx`, `Transcript.tsx`, `useHashPicker.ts`, `itemCardCache.ts`, `openItemRef.ts`, `header/HeaderPrControls.tsx`, `header/TouchedRefControls.tsx`, `header/openTouched.ts`), `home/` (`HomeGitHubSections.tsx`, `HomeSessionSections.tsx`, `TidyUpSection.tsx`), `issues/`, `pull-requests/`, `right-pane/` (`agent-panel-actions.ts`, `agent-tool-dispatch.ts`, `file-explorer/FileExplorerPanel.tsx`, `git-changes/GitChangesHeader.tsx`, `pinned/*`), `profile/` (`ManageSession*.tsx`, `manageSessionsHelpers.ts`, `MemoryTriageDialog.tsx`, `triageSessions.ts`), `palette/paletteItems.ts`. The tidy-up and manage-sessions candidate lists (`TidyUpSection.tsx`, `manageSessionsHelpers.ts`) exclude a `personal` Session so cleanup never offers to archive or delete it (FR-010; no automatic cleanup exists in `src-tauri/src` today, so the T006 registry refusal is the backstop). Existing `*.test.ts` fixtures are edited only if `tsc` demands it; no new cases.
- [X] T018 [US1] Run `cargo check --tests` (in `src-tauri`) and `pnpm typecheck` until both are clean; confirm every file touched or created by T002 to T017 is at or under 600 lines and no baselined file grew (check the baseline list the repo uses for god files).

### Docs and live verification

- [X] T019 [US1] Update `docs/PLAN.md`: move the #2004 row per the plan's rule once the PR is open, keep the #2008 epic row and children rows consistent with this spec (FR-027). No constitution change here (that is #2005).
- [X] T020 [US1] Live verification on a scratch instance (quickstart.md "#2004 data model", plan.md Verification): run the existing `pnpm verify:tauri` flow, or a scratch script in `scripts/` that follows the same pattern, against an isolated data folder seeded with the T001 registry. Confirm all Sessions load as `project` unchanged and round-trip on save (SC-001); a `personal` row adds once, a second is refused with `personal-agent-exists`; archive and delete return `personal-agent-protected` with no agent stopped; rename succeeds; app log has no error. Apply the Refract scratch-instance isolation skill so the real data folder is untouched. Then remove scratch files and any throwaway script. Run `pnpm ci:local` (SC-007).

**Checkpoint**: first PR is complete and changes nothing a developer can see.

---

## Phase 3: #2005 Create and launch (User Story 2, P1)

**Goal**: open the Personal Agent and chat, with the home folder as the agent's working folder and no Worktree.

**Independent Test**: quickstart.md "#2005": clean data folder, one open creates "My Agent", no worktree on disk, agent cwd is the home folder, reply arrives, second open reuses it.

- [X] T021 [US2] Probe omp in a non-repository folder live first (Principle IV, OQ-5): spawn it in the home folder on a scratch data folder, check `get_state` `sessionFile`, the session folder it writes, `switch_session` reattach and a prompt round trip. Record the result as the next free item in `docs/spike/FINDINGS.md`; if omp needs a git repository for a path the Personal Agent uses, record it as a finding and raise it upstream, never a fake repository (FR-015). Resolves OQ-5; no launch change before this lands. Done: FINDINGS item 66 (no repository needed; omp rebinds cwd to temp when cwd is its home, `--cwd` fixes it, see T037).
- [ ] T022 [US2] Amend `.specify/memory/constitution.md` as its own explicit constitution update, before any launch change: Principle I ("one session per git worktree") and Principle III (saved-session scan "in the directory OMP uses for that worktree", reattach "in the session's worktree", and "spawned with the session's own worktree as its cwd") each gain the Personal Agent exception (home folder, no worktree), with the version bump per its governance; update `plan.md` Constitution Check to match.
- [ ] T023 [US2] In `ipc/sessions_lifecycle.rs` (or a new `ipc/personal_agent.rs` registered in `ipc/mod.rs` if the file would pass 600 lines) add an open-or-create handler taking no repository or branch: returns the existing `personal` Session, or creates one named "My Agent" with all four fields `None`, `session_dir` unset and no worktree, via `RegistryStore::add_session` (FR-009, FR-011). Expose it in `shared/ipc.ts` and `tauri-bridge/index.ts`.
- [ ] T024 [US2] In `session/agent/launch.rs` skip the worktree and Project start gate (`:64-94`) for `personal` (FR-013) and use the home folder, resolved on every launch and never stored, as the agent cwd (`:180-182`) and roster cwd (`:207`) (FR-012); a missing or unresolvable home folder fails the launch with a visible error on the Personal Agent and no fallback (OQ-4). Replace the T011 interim refusal. Everything else launches through the existing machinery unchanged (FR-014).
- [ ] T025 [US2] Keep Project launch and creation byte-identical (FR-016); confirm saved-session scanning and `switch_session` reattach work for a home-folder cwd as recorded by T021 (`docs/spike/FINDINGS.md`).
- [ ] T026 [US2] Live verify (quickstart.md "#2005"): SC-003 and SC-004 on a scratch instance. #2005 adds no UI entry point (FR-016a), so call the create-or-open IPC from T023 over CDP; #2006 adds the button. Update `docs/PLAN.md`.

**Checkpoint**: the Personal Agent works end to end from a developer-visible trigger available to the harness.

---

## Phase 4: #2007 Repo-only empty state (User Story 4, P1)

**Goal**: every repo-only surface in the Personal Agent is a disabled state with an explanation, never an error or another Session's data. Depends only on #2004.

**Independent Test**: quickstart.md "#2007".

- [ ] T027 [P] [US4] Give each repo-only handler a typed `no-repository` result for `personal` (FR-024): `ipc/git_changes.rs`, `ipc/file_explorer.rs`, `ipc/files.rs`, `ipc/sessions_lifecycle/diag.rs` (diffStat, reveal), `ipc/pull_requests/handlers.rs`, `ipc/issues.rs`, `ipc/session_kickoff.rs`, `ipc/sessions_lifecycle.rs` `sessions_recreate_worktree`; no panic, no error log. Add `no-repository` to the `IPC_ERROR_CODES` allowlist in `src-tauri/src/ipc/mod.rs` and to its TypeScript mirror in `src/shared/ipc.ts`. Replace the T012 interim returns.
- [ ] T028 [P] [US4] Add one shared repo-only empty state under `src/renderer/components/`, built on the existing `Empty` primitive (ADR 0003), with the title "No repository" and the body "The Personal Agent isn't linked to a Project, so there are no changes, files, or pull requests to show." Title and body are exposed to assistive technology as text (FR-026).
- [ ] T029 [US4] Use it in `right-pane/git-changes/`, `right-pane/file-explorer/FileExplorerPanel.tsx`, the pull request and diff views (`features/pull-requests/`, `features/right-pane/`). Gate on the Session `kind` in the renderer and make no backend call for `personal`; the panels stay visible (FR-022).
- [ ] T030 [US4] In `features/sessions/useWorktreeActions.ts`, `useSessionRowActions.ts` and `SessionDetailsCard.tsx` remove copy worktree path, reveal and recreate worktree from the menus for `personal` (do not show them disabled), and show archive and delete disabled with the reason "The Personal Agent cannot be archived or deleted" (FR-023). Project Sessions unchanged (FR-025).
- [ ] T031 [US4] Live verify with CDP on a scratch instance (quickstart.md "#2007"): SC-005 and SC-006; Worktree actions absent from the menus; app log clean; update `docs/PLAN.md`.

**Checkpoint**: the Personal Agent shows no repo errors.

---

## Phase 5: #2006 Launcher button (User Story 3, P1)

**Goal**: launcher button, divider, "Projects" label, then the groups. Depends on #2005.

**Independent Test**: quickstart.md "#2006".

- [ ] T032 [P] [US3] Add a launcher button, section label and divider from the shared reusable components in `src/renderer/components/` (FR-021): a real labelled button with a visible focus ring and a non-colour-only selected state; the label is a heading for the group below.
- [ ] T033 [US3] In `features/sessions/SessionList.tsx` (and `ProjectListPane.tsx` if it owns the layout) render, from the top: launcher, divider, "Projects" label, then the existing groups; keep the `personal` Session excluded from the group data so counts, ordering and collapse are unchanged (FR-017, FR-020).
- [ ] T034 [US3] Wire activation to the T023 open-or-create handler and select the Session; show the current name and the Session row's active, working or waiting state from the same status mapping (`sessionDisplay.tsx`) (FR-018, FR-019).
- [ ] T035 [US3] Live verify with CDP on a scratch instance: layout order, states, rename, keyboard focus, no `personal` row in any group (quickstart.md "#2006"); update `docs/PLAN.md`.

**Checkpoint**: the epic acceptance is met.

---

## Phase 6: Polish

- [ ] T036 Run `pnpm ci:local`; confirm no file over 600 lines and no baselined file grew; update `CONTEXT.md` only if wording changed; set the spec Status to `Implemented` when the last child lands; close #2008 per the plan's rules.

---

## Dependencies and execution order

- T001 first. T002 then T003 then T004 to T008 (same file, sequential); T009 after T004; T010 is independent of the Rust tasks; T011 to T013, T015 to T017 run in parallel after T003 and T010 respectively; T014 after T011 to T013; T018 after all; T019 and T020 last.
- Phase 3 (#2005) needs Phase 2 merged. Phase 4 (#2007) needs only Phase 2 and can run in parallel with Phase 3. Phase 5 (#2006) needs Phase 3.

## Parallel example (Phase 2)

```text
Rust consumers:  T011, T012, T013 (different files)
TypeScript:      T010 first, then T015, T016, T017 (different files)
```

## Implementation strategy

First PR: Phases 1 and 2 only (MVP, invisible to developers, unblocks every other child). Then Phase 3 for the first usable Personal Agent, Phase 4 to remove errors, Phase 5 for the launcher button. Each later phase is converged against this spec before starting.

---

## Phase 7: Convergence

- [ ] T037 [US2] The Personal Agent launch also passes `--cwd=<resolved home folder>` to omp (`omp/process_args.rs` and `OmpProcessOptions`), because omp rebinds its working folder to the OS temp folder when the spawn cwd is its own home folder (FINDINGS item 66, T021); `current_dir` alone leaves the agent's tools in temp, so SC-004 would fail. Project launch args stay byte-identical. per FR-012 (partial)
