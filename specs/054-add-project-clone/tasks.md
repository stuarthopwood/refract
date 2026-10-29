# Tasks 054

Order is dependency order. `[P]` means parallel with the previous task (different files). No tests are written (prototyping rule); each task is verified by the quickstart step in brackets or by `pnpm ci:local`.

## PR 1: flyout, Clone dialog, background clone, default folder

### Phase 1: Rust backend

- [ ] T001 [PR1] `src-tauri/src/github/repo_ref.rs`: `RepoRef`, `parse_source`, owner and name validators; register in `github/mod.rs` (FR-025) [step 10]
- [ ] T002 [PR1] [P] `src-tauri/src/github/repo_list.rs`: `list_orgs`, `list_owner_repos`, description sanitiser, sort by `updatedAt` desc (FR-026, FR-028) [steps 3, 4]
- [ ] T003 [PR1] `src-tauri/src/github/repo_clone.rs`: `CloneJob` (spawn via `resolve_gh`, argv, stderr stage parser, fixed failure sentences, idempotent cancel, once-only exit) (FR-022, FR-023, FR-030, FR-032) [steps 6, 12, 13]
- [ ] T004 [PR1] `src-tauri/src/ipc/repositories.rs`: extract `add_repository_at(state, path)`; `repositories_add` calls it; no behaviour change (FR-031, FR-036)
- [ ] T005 [PR1] `src-tauri/src/store/settings.rs`: `default_clone_folder` field, load validation, `set_default_clone_folder`; new `src-tauri/src/ipc/settings_default_clone_folder.rs` with `settings.setDefaultCloneFolder` broadcasting `settings:changed` (FR-035) [step 7]
- [ ] T006 [PR1] Progress event emitter `emit_repositories_clone_progress` in the session events module (new sibling file if the cap is near) (FR-023)
- [ ] T007 [PR1] `src-tauri/src/ipc/repositories_clone.rs`: `listGitHub(owner?)`, `clone`, `cloneCancel`; clone registry (cap 4, destination set), destination validation, existing-Project match, created-by-us cleanup, add-after-clone, app-exit cancel; register in `ipc/mod.rs` (FR-017, FR-021, FR-024, FR-027, FR-029, FR-031, FR-033, FR-034) [steps 9, 11, 12, 14]
- [ ] T008 [PR1] `src-tauri` build check is left to the gate (`pnpm ci:local` runs `cargo fmt`, `clippy`, `cargo test`); confirm no file passes 600 lines

### Phase 2: Contract and bridge

- [ ] T009 [PR1] `src/shared/ipc-repositories-clone.ts`: all types from `contracts/ipc.md`, plus the `Settings.defaultCloneFolder` addition, without growing `src/shared/ipc.ts` (FR-036)
- [ ] T010 [PR1] `src/shared/ipc.ts`: channel and event constants and `window.refract` members, net zero lines (extract a block to a new module if needed); parity map and `tauri-bridge` entries for `listGitHub`, `clone`, `cloneCancel`, `setDefaultCloneFolder`, `onCloneProgress`

### Phase 3: Renderer shared pieces

- [ ] T011 [PR1] `src/renderer/components/FilterableGroupedListbox.tsx`: extracted pattern from `ModelPicker` (combobox, listbox, sticky group headers, count, live region, per-group retry row) (FR-007, FR-010, FR-011)
- [ ] T012 [PR1] [P] `src/renderer/state/notify.ts`: loading-toast helper with Cancel action, success with Open, cancelled, persistent error (FR-018, FR-019)
- [ ] T013 [PR1] `src/renderer/features/sessions/AddProjectMenu.tsx`: `variant` and `side` props over `ui/dropdown-menu` (FR-001 to FR-004)
- [ ] T014 [PR1] `git mv` `AddRepositoryDialog.tsx` to `AddProjectDialog.tsx`, retitle, update importers (FR-005)

### Phase 4: Clone flow

- [ ] T015 [PR1] `src/renderer/features/sessions/clone-destination.ts`: default path, parent, checkbox state helpers (FR-014, FR-015)
- [ ] T016 [PR1] `src/renderer/state/clones-store.ts`: active clones, `onCloneProgress` subscription, toast driving, add Project to `repositories-store`, Open selects the Project, save default folder after a started clone (FR-015, FR-018, FR-019, FR-031)
- [ ] T017 [PR1] `src/renderer/features/sessions/CloneProjectDialog.tsx`: filter, listbox, paste with validation messages, destination, checkbox, signed-out state with R9 Sign in, Already added and Open project (FR-006, FR-009, FR-012 to FR-017) [steps 3 to 11, 15]
- [ ] T018 [PR1] `SessionList.tsx` footer and `Readiness.tsx`: replace `AddRepositoryDialog` with `AddProjectMenu`, wire both dialogs (FR-001, FR-003, FR-005) [steps 1, 2]
- [ ] T019 [PR1] Settings > Projects: `SettingsNav.tsx` entry, `features/settings/ProjectsSection.tsx`, `SettingsScreen.tsx` route; `SettingRow`, Browse, Clear (FR-020) [step 7]

### Phase 5: Docs and gate

- [ ] T020 [PR1] `docs/design/components.md`: Add project menu and Filterable grouped listbox notes; `docs/PLAN.md` status
- [ ] T021 [PR1] Gate: `pnpm ci:local`, quickstart steps 1 to 17, five reviewers (incl. accessibility), file-size check, `pnpm worktrees:reap` after merge

## PR 2: Project term (coarser)

- [ ] T030 [PR2] Inventory regex hits for `repositor(y|ies)` in `src/renderer` and Rust UI-reaching strings; classify each as user-visible or identifier (FR-041)
- [ ] T031 [PR2] Change user-visible renderer strings (Session list, Manage sessions, Pull requests, Settings, dialogs, announcements, empty states) and Rust UI-reaching errors incl. `REPOSITORY_HAS_SESSIONS_MESSAGE`; keep "GitHub repository" (FR-041, FR-042)
- [ ] T032 [PR2] Confirm identifiers, `repositories.*`, registry schema and `registry.json` untouched (FR-043)
- [ ] T033 [PR2] Amend `specs/001-core-session-workspace/spec.md` FR-055 term list (FR-044)
- [ ] T034 [PR2] `CONTEXT.md` glossary and `docs/DESIGN.md`, `docs/design/*` wording (FR-045)
- [ ] T035 [PR2] Gate: `pnpm ci:local` (incl. `check:ui-text`), live scan per quickstart PR 2 note, reviewers (FR-046)
