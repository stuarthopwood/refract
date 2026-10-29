# Plan 054: Add project and clone from GitHub

Spec: `spec.md`. Two PRs; PR 2 starts after PR 1 merges.

## PR 1

### Rust (all new modules; `repositories.rs` gains only an extracted function)

- `src-tauri/src/github/repo_ref.rs`: `RepoRef { owner, name }`, `parse_source(&str)`, owner and name validators (FR-025). Pure, no I/O.
- `src-tauri/src/github/repo_list.rs`: `list_owner_repos(owner)` over `gh_json` (`repo list ... --limit 100`), `list_orgs()`, description sanitiser (FR-026, FR-028).
- `src-tauri/src/github/repo_clone.rs`: `CloneJob` modelled on `GhLoginFlow` (`cli.rs`): `resolve_gh`, argv array, `CREATE_NO_WINDOW`, stdin closed, stderr reader splitting on `\r`/`\n`, stage parser, 2 KB private tail and fixed failure sentences, idempotent `cancel()` (stdin close, 750 ms grace, `taskkill /T /F`), guarded `exited` flag so the exit event fires once.
- `src-tauri/src/ipc/repositories_clone.rs`: `register()` for `repositories.listGitHub`, `repositories.clone`, `repositories.cloneCancel`; an in-flight map (`cloneId` to job, cap 4, destination set); destination validation and the created-by-us cleanup (FR-027, FR-029); existing-Project match through `git::remote`; progress emit; add-after-clone (FR-031). App-exit cancel hook (FR-033).
- `src-tauri/src/ipc/repositories.rs`: extract the body of `repositories_add` into `pub(super) async fn add_repository_at(state, path)`; `repositories_add` calls it. No behaviour change.
- `src-tauri/src/store/settings.rs` plus new `src-tauri/src/ipc/settings_default_clone_folder.rs`: `defaultCloneFolder: Option<String>`, `set_default_clone_folder`, handler `settings.setDefaultCloneFolder`, broadcast `settings:changed` (FR-035).
- Event emitter `emit_repositories_clone_progress` beside `emit_updates_state_changed` in `session/events.rs` (new sibling file if that file is near its cap).
- Register both modules in `ipc/mod.rs`.

### Contract and bridge

- `src/shared/ipc-repositories-clone.ts` (new): all new types (see `contracts/ipc.md`).
- `src/shared/ipc.ts`: only channel constants, event constant and the `window.refract` method signatures, using the 902-line baseline: net zero lines is required, so the new `repositories` and `settings` members are declared via an interface in the new module and merged in (`RefractApi` extends it). If a net-zero edit is impossible, extract an existing block to a new module in the same change.
- `scripts/` parity map and `src/renderer/tauri-bridge` entries for the three invokes, one setter and one event subscription.

### Renderer

- `components/FilterableGroupedListbox.tsx` (new, extracted from `ModelPicker`'s combobox/listbox pattern; `ModelPicker` unchanged).
- `src/renderer/state/notify.ts` (existing): add `notifyProgress(id)` returning `update`, `succeed`, `fail`, `cancelled` for a loading toast with an action.
- `features/sessions/AddProjectMenu.tsx` (new; props `variant: 'footer' | 'first-run'`, `side`), `AddProjectDialog.tsx` (git mv from `AddRepositoryDialog.tsx`, retitled), `CloneProjectDialog.tsx` (new), `clone-destination.ts` (pure helpers: default path, parent, checkbox state).
- `state/clones-store.ts` (new): active clones by `cloneId`, subscribes to `repositories.cloneProgress`, drives the toast, calls `repositories-store` to add the Project and select it on Open.
- `features/sessions/SessionList.tsx` footer and `Readiness.tsx` swap `AddRepositoryDialog` for `AddProjectMenu` (small edits; `SessionList.tsx` collides with #811, #638, #735, #748, so rebase before the gate).
- Settings: `SettingsNav.tsx` entry `projects`, `features/settings/ProjectsSection.tsx` (new) using `SettingRow`; `SettingsScreen.tsx` routes it.

### Docs touched in PR 1

- `docs/PLAN.md` row status; `docs/design/components.md` gains "Add project menu" and "Filterable grouped listbox" notes.

## PR 2 (coarser)

- Classify every regex hit for `repositor(y|ies)` in `src/renderer` and Rust UI-reaching strings; change user-visible text only.
- Amend `specs/001-core-session-workspace/spec.md` FR-055 term list; `CONTEXT.md` glossary; `docs/DESIGN.md` and `docs/design/*`.
- Verify `pnpm ci:local` and `check:ui-text`; live check for screens touched.

## Constraints

- 600-line cap: `ipc.ts` (902 baseline, must not grow), `repositories.rs` (565), `settings.rs` (544).
- Principle V: no shell, validated inputs, no remote content.
- No new tests (prototyping rule).
- Gate: `pnpm ci:local`, then the five reviewers (UI branch includes accessibility).
- Safe deletion: only the app's own created clone folder by literal resolved path (FR-029); no other deletes.
