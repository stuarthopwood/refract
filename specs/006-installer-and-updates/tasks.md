# Tasks: Installer and updates

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: Windows 11; Node 24+; `pnpm`; `omp` 18.4.x or 18.5.x signed in; Git for Windows; `gh` signed in to a GitHub account with write access to `stuarthopwood/refract` (for Story 5 and the probes).

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand against the packaged app. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`; this spec adds `pnpm package` (electron-builder) as a further required gate from Phase 2 onward.

**Organization**: tasks are grouped by user story so each story can be built and checked on its own. Paths are relative to the repository root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US5). Setup, Foundational, and Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Setup and gates

**Purpose**: settle the five facts the constitution (Principle IV) says must be verified before
the work that depends on them. `research.md` already cites the exact vendor sources read for each;
these tasks confirm them by actually running the thing, not by reading further.

- [ ] T001 [P] Gate: on a disposable Windows profile with no `omp` present, run OMP's real install script (`irm https://omp.sh/install.ps1 | iex`) both with `-Binary -Ref <a known OMP release tag>` and with no flags at all; confirm the pinned tag installs to `%LOCALAPPDATA%\omp\omp.exe` unattended (no prompt) and that `omp --version` afterwards reports the version that tag implies; record the exact tag-to-version mapping and whether a freshly spawned child process (not the installing shell) can resolve `omp.exe` without a `PATH` refresh in `docs/spike/FINDINGS.md` (research.md decision 6). (#212)
- [ ] T002 [P] Gate: on the same or a second disposable profile, download Git for Windows' and the GitHub CLI's latest official installers and run each with the unattended flag sets from `research.md` decision 6 (`/VERYSILENT /NORESTART /NOCANCEL /SP- /CURRENTUSER` for Git; `msiexec /i <path> /quiet /norestart` for the GitHub CLI MSI); confirm whether either needs an administrator prompt, and if `/CURRENTUSER` fails to produce a no-admin Git install, note the fallback (run without `/VERYSILENT`, letting Git's own installer prompt, per FR-011); record both outcomes in `docs/spike/FINDINGS.md`. (#218)
- [ ] T003 [P] Gate: scaffold a minimal `electron-builder.yml` (`appId`, `productName: Refract`, `win.target: nsis`, default `oneClick`/`perMachine`, `asarUnpack` for `koffi`'s native binary per spec 001 research.md decision 13) against the current `pnpm build` output, run `pnpm exec electron-builder --win` once, and install the result on a disposable profile: confirm no administrator prompt, a Desktop shortcut, a Start Menu entry, a Windows Settings > Apps entry showing the version, and that running the same installer again upgrades in place without disturbing a scratch `%APPDATA%/pinion`; record the result in `docs/spike/FINDINGS.md` (this scaffold becomes T006's real config). (#223)
- [ ] T004 [P] Gate: add `build/installer.nsh` with a trivial `customUnInstall` (a `MessageBox MB_YESNO`) and `customUnInit` (a `MessageBox` guard) stub, rebuild with T003's config, and confirm both fire on an interactive uninstall and that `customUnInit`'s guard is reachable; separately confirm the silent switch `/S` on the built installer completes with no UI; record both outcomes, and whether electron-builder's default template already warns on a running instance without `customUnInit`, in `docs/spike/FINDINGS.md` (research.md decision 2). (#230)
- [ ] T005 [P] Gate: with `gh` signed in to an account that can read `stuarthopwood/refract`, create one scratch private Release on this repository carrying a dummy `.exe` and a `.sha256` file, then confirm `gh release list --json tagName,isDraft,isPrerelease`, `gh release view <tag> --json assets`, and `gh release download <tag> --pattern '*.exe' --pattern '*.sha256' --dir <scratch>` all work as research.md decision 3 assumes; separately confirm `gh auth status` reliably reports signed-out after `gh auth logout` and that a `gh release list` call fails distinguishably when offline; delete the scratch release afterward; record the result in `docs/spike/FINDINGS.md`. (#236)

**Checkpoint**: `docs/spike/FINDINGS.md` has five new numbered items; each later phase can cite its result instead of re-deriving it.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the shared types, persisted state, and packaging config every story builds on.

- [ ] T006 Turn T003's scaffold into the real `electron-builder.yml` at the repository root (or the `build` key in `package.json`, matching whichever T003 used) and add `electron-builder@26.15.3` as a devDependency and a `"package": "electron-builder --win"` script in `package.json`; wire `build/icon.ico` (the real icon, already landed via issue #91) as the icon path -- just point electron-builder's `win.icon` at the existing file (depends on T003). (#243)
- [ ] T007 Turn T004's stub into the real `build/installer.nsh`: `customUnInstall` asks "Delete Refract's settings and session list?" (`MessageBox MB_YESNO|MB_DEFBUTTON2`, so **No**/keep is the default per FR-023) and, only on **Yes**, `RMDir /r` the per-user `%APPDATA%\pinion` folder; `customUnInit` detects a running Refract process (the existing single-instance lock, or a `tasklist` check for the packaged exe name) and shows a message asking the developer to close it first, refusing to continue until it is closed (FR-024) (depends on T004, T006). (#249)
- [ ] T008 Extend `src/shared/ipc.ts` per [contracts/ipc.md](contracts/ipc.md): add `github: Check` to `Readiness`; add `IpcErrorCode` entries `dependency-install-failed`, `update-unavailable`, `checksum-mismatch`; add the `DependencyInstallProgress` and `UpdateState` types (data-model.md); add `IPC_REQUESTS`/`IPC_EVENTS` entries for `readiness.installDependency`, `updates.check`, `updates.getState`, `updates.install`, `app.getVersion`, `readiness:install-progress`, `readiness:changed`, `updates:state-changed`; extend `RefractApi` with the matching methods and event subscriptions; update `src/preload/index.ts` to pass them through `contextBridge` exactly like every existing channel. (#256)
- [ ] T009 [P] Write `src/main/store/updateState.ts`: `updateState.json` in `app.getPath('userData')`, default `{ version: 1, phase: 'idle' }`, read/write through the existing `src/main/store/atomicJson.ts` helper (depends on T008). (#262)
- [ ] T010 [P] Add `checkGithubCli()` to `src/main/readiness.ts` (resolve `gh` via `resolveExecutable`, `gh --version`, then `gh auth status`; `ok` only when both succeed) and include it as `github` in `readinessCheck()`'s return value, without changing what the renderer treats as "all pass" (depends on T005, T008). (#267)

**Checkpoint**: `pnpm typecheck`, `pnpm build`, and the new `pnpm package` all succeed; the packaged app still runs and its readiness screen still shows git/omp/sign-in exactly as before (the new `github` field is present in the IPC payload but not yet rendered).

---

## Phase 3: User Story 1 - Install Refract (Priority: P1)

**Goal**: one downloaded installer file, no admin, Desktop and Start Menu shortcuts, an Apps &
Features entry with the version, and an in-place upgrade that keeps repositories, Sessions, and
settings.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [ ] T011 [US1] Finish the packaging config from T006 against the real app: confirm `pnpm package` produces one `.exe` under `release/`, that it installs per-user with no admin prompt, that both shortcuts use the Refract icon and open Refract, that Windows Settings > Apps shows the installed version, and that running the same installer again upgrades in place while a scratch `%APPDATA%/pinion` (registry.json, settings.json, processes.json) survives untouched (FR-001 to FR-004) (depends on T006, T007). (#273)
- [ ] T012 [US1] In `src/main/index.ts`, call `app.setAppUserModelId(...)` unconditionally (today it is dev-only, per its existing comment) using the same `appId` as `electron-builder.yml`, so Windows notifications, the taskbar icon, and the Apps & Features identity stay the same identity across every upgrade (depends on T011). (#277)
- [ ] T013 [US1] Update the docs and verify live: `README.md` ("There is no packaged installer yet" replaced with how to run `pnpm package` and where the installer lands), `quickstart.md` Story 1 prerequisites if anything changed while building it; then on a clean Windows profile run quickstart Story 1 end to end (depends on T011, T012). (#283)

**Checkpoint**: run quickstart Story 1 on the packaged app on a clean profile.

---

## Phase 4: User Story 2 - Get missing dependencies from the first-run screen (Priority: P1)

**Goal**: Install actions for Git, OMP (pinned 18.4.x/18.5.x), and the optional GitHub CLI, with progress,
outcome, and an automatic re-check, all from the existing readiness screen.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [ ] T014 [US2] Write `src/main/dependencyInstall.ts`: `installGit()`, `installOmp()`, `installGithubCli()`, each downloading the vendor's official installer/script over HTTPS to `app.getPath('temp')` and running it with the unattended flag set T002/T001 confirmed (`installOmp()` runs `resolvePowerShell()` with `-Binary -Ref <OMP_PINNED_TAG>`, a constant chosen from T001's result per research.md decision 7), emitting `DependencyInstallProgress` at each phase; a failure at any phase emits `'failed'` with an actionable `detail`, never throws past the IPC boundary (FR-005, FR-006, FR-010, FR-011) (depends on T001, T002, T008). (#288)
- [ ] T015 [US2] Add `readiness.installDependency(dependency)` to `src/main/ipc/readiness.ts`: validates the `dependency` argument, awaits the matching `dependencyInstall.ts` function while forwarding its progress on `readiness:install-progress`, and on success re-runs `readinessCheck()` and emits `readiness:changed` before resolving; a failure resolves `dependency-install-failed` (contracts/ipc.md) (depends on T010, T014). (#293)
- [ ] T016 [P] [US2] Extend `src/renderer/features/readiness/Readiness.tsx`: an Install button next to the `git` and `omp` rows whenever `!ok`, wired to `readiness.installDependency`, showing live progress and outcome text from `readiness:install-progress` and `readiness:changed`; a fourth row for `github`, labelled "optional", that never affects whether **Add repository** is enabled; the `ompSignedIn` row is unchanged (manual hint only, FR-009) (depends on T008, T015). (#298)
- [ ] T017 [US2] Update the docs and verify live: `docs/DESIGN.md` ("First run and empty states" gains the Install actions and the optional GitHub CLI row), `README.md` Prerequisites (note the GitHub CLI as optional, needed for updates and spec 003), `quickstart.md` Story 2; then on a profile missing Git and OMP, run quickstart Story 2 end to end, including the offline-failure check (depends on T014, T015, T016). (#304)

**Checkpoint**: run quickstart Story 2 on the packaged app.

---

## Phase 5: User Story 3 - Learn about and install updates (Priority: P2)

**Goal**: a startup and on-demand check against private GitHub Releases through `gh`, a badge with
a release-notes link, checksum-verified download, and install only at the next normal quit.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [ ] T018 [US3] Write `src/main/update/UpdateChecker.ts`: `check()` runs `gh auth status` first (an unavailable or signed-out result resolves to `phase: 'idle'` with `unavailableReason` set, never an error, FR-017); otherwise `gh release list` then `gh release view` the newest non-draft, non-prerelease tag whose assets include both an installer and a checksum file and whose version (hand-written `compareVersions`, research.md decision 9) is newer than `app.getVersion()` (FR-019, FR-026); resolves to `phase: 'available'` with `availableVersion`/`notesUrl`, or back to `'idle'` when nothing qualifies (depends on T008, T009). (#309)
- [ ] T019 [US3] Write `src/main/update/UpdateInstaller.ts`: `download()` persists `phase: 'downloading'` before it starts, runs `gh release download` for the available release's installer and checksum assets into `userData/updates/`, recomputes the installer's SHA-256 with Node's `crypto`, and on a match persists `phase: 'downloaded'` with `installerPath`; a mismatch deletes the downloaded file and persists `phase: 'failed'` with `lastError` (FR-014) (depends on T009, T018). (#314)
- [ ] T020 [US3] Write `src/main/update/installOnQuit.ts` and wire it into `src/main/index.ts`'s `before-quit`: when `updateState.phase === 'downloaded'`, spawn a detached, unref'd helper that waits for Refract's own pid to exit, then runs the installer with `/S` (research.md decision 5), and persist `phase: 'installing'` before Refract's own quit proceeds; at the very start of `src/main/index.ts` (before T021's automatic check), resolve a persisted `'installing'` phase from the previous run by comparing `app.getVersion()` to the persisted target version: `'idle'` on a match, `'failed'` with `lastError` on a mismatch (FR-015, FR-016, FR-018) (depends on T009, T019). (#318)
- [ ] T021 [US3] Write `src/main/ipc/updates.ts` (`updates.check`, `updates.getState`, `updates.install`, `app.getVersion`) and register it in `src/main/ipc/register.ts`; broadcast `updates:state-changed` on every phase transition, the same pattern `settings.ts` already uses for `settings:changed`; call `updates.check()` once automatically from `src/main/index.ts` after the window is shown, never awaited before `BrowserWindow.show()` (FR-020, SC-010) (depends on T018, T019, T020). (#322)
- [ ] T022 [P] [US3] Extend `src/renderer/features/status-bar/StatusBar.tsx` with the update badge as an INTERIM home (research.md decision 11; spec 001 T099 moves this badge and the Check for updates action to the update entry of spec 008's profile menu, FR-021, before it deletes the status bar): hidden while `phase` is `'idle'`/`'checking'`; shows the available/downloaded version and a release-notes link (`shell.openExternal` via the existing safe path) once `phase` is `'available'` or later; a "Check for updates" and "Update" action in its popover; fully keyboard-reachable with a visible focus indicator alongside the bar's existing controls (FR-012, FR-013, FR-027) (depends on T021). (#327)
- [ ] T023 [US3] Update the docs and verify live: `README.md`, `docs/DESIGN.md` (the status bar's new badge, noting spec 004/008 will add their own permanent entries later against the same API), `quickstart.md` Story 3; then run quickstart Story 3 end to end against a scratch private Release, including the signed-out/offline plain-words path (depends on T018 to T022). (#331)

**Checkpoint**: run quickstart Story 3 on the packaged app.

---

## Phase 6: User Story 4 - Uninstall (Priority: P2)

**Goal**: an uninstaller reachable from Windows Settings > Apps and the Start Menu folder, a
keep-or-delete-data prompt defaulting to keep, and a close-Refract-first guard when it is running.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [ ] T024 [US4] Verify T007's `installer.nsh` against the fully packaged app (not T004's stub): uninstalling from Windows Settings > Apps and from the Start Menu folder's uninstall entry both work; the keep-or-delete-data prompt defaults to keep; choosing delete removes `%APPDATA%/pinion` and choosing keep does not; Git, OMP, the GitHub CLI, repositories, worktrees, and OMP conversations are untouched either way; starting an uninstall while Refract is running shows the close-first guard instead of removing files (FR-021 to FR-024) (depends on T007, T011). (#334)
- [ ] T025 [US4] Update the docs and verify live: `README.md`, `quickstart.md` Story 4; then run quickstart Story 4 end to end, once choosing keep and once choosing delete (depends on T024). (#337)

**Checkpoint**: run quickstart Story 4 on the packaged app.

---

## Phase 7: User Story 5 - Publish a release (maintainer) (Priority: P3)

**Goal**: one tag-triggered CI action that builds the installer and publishes it, with its
checksum and release notes, as a private GitHub Release that Story 3's checker can find — and that
correctly ignores an incomplete, draft, or pre-release one.

**Independent test**: [quickstart.md](quickstart.md) Story 5.

- [ ] T026 [US5] Write `.github/workflows/release.yml` (research.md decision 8): triggers on a pushed tag matching `v*.*.*`; a guard step fails the job if the tag's numeric part does not equal `package.json`'s `"version"`; then `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm package`, compute the installer's SHA-256 into a sibling `.sha256` file, and `gh release create <tag> <installer> <checksum file> --repo stuarthopwood/refract --generate-notes`, adding `--prerelease` when the tag carries a `-rc`/`-beta`/`-alpha` suffix (FR-025). (#341)
- [ ] T027 [US5] Update the docs and verify live: `README.md` (how a maintainer cuts a release), `quickstart.md` Story 5; then tag a scratch version (bumped and mismatched cases both) and confirm the workflow's guard and happy path both behave as written, and that T018's checker correctly ignores a release missing an asset, a draft, and a pre-release (FR-019, FR-026) (depends on T026, T018). (#344)

**Checkpoint**: run quickstart Story 5 against a real tag push.

---

## Phase 8: Polish and cross-cutting

- [ ] T028 [P] Security pass against constitution V for every surface this spec added: every HTTPS/`gh`/vendor-installer/`msiexec` call happens in main only, to the fixed hosts named in contracts/ipc.md, through `resolveExecutable` (never a bare executable name); the renderer never receives a URL or a file path it could act on, only the typed `Readiness`/`DependencyInstallProgress`/`UpdateState` values; release notes and any other link open only through `openExternalSafe`. (#348)
- [ ] T029 Final docs and build gate: update `README.md`'s Status section, `docs/DESIGN.md` and `CONTEXT.md` for anything decided while building (the GitHub CLI's place in readiness vocabulary, if any), and `docs/spike/FINDINGS.md` (move any now-resolved items out of "Open items"); `pnpm typecheck`, `pnpm build`, and `pnpm package` all pass; commit and push to `main`. (#349)

---

## Dependencies and execution order

- **Setup (Phase 1)**: T001 to T005 are five independent probes and can all run in parallel.
- **Foundational (Phase 2)**: T006 needs T003; T007 needs T004 and T006; T008 is independent of T006/T007 and can start immediately; T009 and T010 need T008 (and T010 also needs T005).
- **User stories** need Phase 2 and are then largely independent: US1 (T011 to T013) needs T006, T007. US2 (T014 to T017) needs T001, T002, T008, T010 but not US1. US3 (T018 to T023) needs T008, T009 but not US1 or US2. US4 (T024 to T025) needs US1's T011 and Phase 2's T007. US5 (T026 to T027) needs US3's T018 for its own verification step, but its workflow file itself has no code dependency on any other story.
- **Polish** last.

## Parallel examples

- Phase 1: T001 to T005 together (five disposable-profile or scratch-repository probes, no shared files).
- Phase 2: once T008 lands, T009 and T010 together (two different files).
- US2: T016 (renderer) can start as soon as T008 and T015 exist, in parallel with nothing else in that phase (T014 and T015 touch files T016 does not).
- US3: T022 (renderer) runs in parallel with nothing else once T021 exists, since T018 to T021 are sequential edits to the same new `update/` module group.

## Implementation strategy

1. **MVP**: Phases 1, 2, and 3 (Story 1) — a packaged, installable, upgradeable Refract.
2. Add Story 2 next: without it, a clean install is unusable until the developer separately finds
   and installs Git and OMP by hand.
3. Then US3 (updates), US4 (uninstall), and US5 (publish action) in that order, running each
   checkpoint and pushing after each.

## Notes

- The gates T001 to T005 change the plan if they fail (most likely: `/CURRENTUSER` not actually
  working for Git, or OMP's tag naming not matching `omp --version`'s report); record the result in
  `docs/spike/FINDINGS.md` before building on it, exactly as research.md's "UNVERIFIED" markers
  anticipate.
- Commit after each task or small group; keep `main` building and packaging.
- FR and SC ids in task text refer to [spec.md](spec.md). FR-007 (OMP reported unsupported with an
  explanation, never silently downgraded) needs no new task: it is already satisfied by the
  existing `checkOmp()` (spec 001), which this spec's T010/T015 leave unchanged; T017's quickstart
  run re-confirms it alongside the new Install action.
- GitHub issues: every task has an issue titled `006-Tnnn: ...`, labelled with a type
  (`enhancement`, `spike`, `chore`, or `documentation`), area `build`, priority (`p1` for Phases 1
  to 4, `p2` for Phases 5, 6, and 8, `p3` for Phase 7), and `spec:006`. Created with
  `/speckit.taskstoissues`; issue numbers are recorded below once created.

## Issue mapping

Created 2026-10-02 with `/speckit.taskstoissues`. All in `stuarthopwood/refract`, label `spec:006`.

| Task | Issue | Task | Issue | Task | Issue |
|---|---|---|---|---|---|
| T001 | #212 | T011 | #273 | T021 | #322 |
| T002 | #218 | T012 | #277 | T022 | #327 |
| T003 | #223 | T013 | #283 | T023 | #331 |
| T004 | #230 | T014 | #288 | T024 | #334 |
| T005 | #236 | T015 | #293 | T025 | #337 |
| T006 | #243 | T016 | #298 | T026 | #341 |
| T007 | #249 | T017 | #304 | T027 | #344 |
| T008 | #256 | T018 | #309 | T028 | #348 |
| T009 | #262 | T019 | #314 | T029 | #349 |
| T010 | #267 | T020 | #318 | | |

The same table is posted as a comment on tracking issue #117.

## Phase 9: Convergence

- [x] T030 Add the `NSIS_HOOK_PREINSTALL`/`NSIS_HOOK_POSTINSTALL` pair and extend `NSIS_HOOK_POSTUNINSTALL` in `src-tauri/installerHooks.nsh`: a silent install never adds the Desktop shortcut and keeps an existing one; uninstall (not upgrade) removes `$DESKTOP\Refract.lnk`; the finish-page checkbox stays Tauri's own (ticked by default) per FR-028, FR-029, FR-030 (missing)
- [x] T031 Live-verify on a real installer: interactive Enter-through creates the shortcut targeting the installed exe, `/S` creates none and keeps an existing one, silent uninstall removes it, then restore the previous version per FR-028, FR-029, FR-030 (missing)

## Phase 10: Convergence (issue #883, FR-032 to FR-035)

Appended by `/speckit.converge` on 2026-10-22: the code only checks at startup and needs a click to
download (FR-012, FR-014). Task ids continue after the #881 convergence phase (T030 and T031).

- [ ] T032 [US3] FR-032 (partial): add the 4-hour periodic re-check in `src-tauri/src/updates/mod.rs` (`run_periodic_update_checks`, tick skipped while checking, downloading, downloaded, or installing; the debug-only `REFRACT_UPDATE_CHECK_INTERVAL_SECS` override, ignored in release builds) and start it from `src-tauri/src/lib.rs` setup after the startup check. Rust unit tests for the interval resolution and the skip predicate.
- [ ] T033 [US3] FR-033 (partial): run the startup check and every re-check as one cycle (`run_update_cycle`) that calls `installer::download_update` when the check lands on `available`, with no click; `run_startup_update_check` takes the data directory.
- [ ] T034 [US3] FR-035 (missing): add the `updates.installNow` IPC (`src-tauri/src/ipc/updates.rs`, `src/shared/ipc.ts`, `src/shared/updates.ts`; `pnpm check:parity`) that requires phase `downloaded`, flags a relaunch, and quits through the normal exit path so `run_install_on_quit_hook` verifies and hands off the install; `install_on_quit.rs` relaunches Refract after the silent installer finishes when flagged. Also resolve a stale `downloaded` phase at startup when its version is already installed.
- [ ] T035 [US3] FR-034 (missing): add an update row to the sidebar notice stack (`src/renderer/features/profile/ProfileAlertRows.tsx` and a new shared-row-based `UpdateAlertRow`) showing "Refract <version> is ready" with an "Update now" action; update the footer badge copy in `src/renderer/features/status-bar/StatusBar.tsx` (no "Download update" step; "Update now" in the popover).
- [ ] T036 [US3] FR-035 (missing): the confirm dialog "N agents are running; restarting stops them" with Cancel and "Restart and update", built on the shared `AlertDialog`, shown only when an agent is mid-turn.
- [ ] T037 [US3] Verify live (`scripts/verify-883-updates.mjs`): fake `gh` on `PATH`, debug interval override, assert no prompt at launch, periodic detection, automatic download, the notice row and footer badge, and the confirm dialog where the fake-omp fixtures allow; screenshots of each state.
- [ ] T038 [US3] Docs: update `specs/006-installer-and-updates/quickstart.md` Story 3 for the periodic check and Update now, and `docs/PLAN.md` row #883 to `done`.

## Phase 11: Convergence (issue #1175, FR-035)

Appended by `/speckit.converge` on 2026-10-28: the Update now confirm undercounts, `installNow` can quit
without installing, and a repeated `ExitRequested` can double the hand-off. Task ids continue after T038.

- [x] T039 [US3] FR-035 (partial): `useUpdateNow.tsx` counts every non-archived session whose status is not `stopped`, and keeps the confirm count as state set when the confirm opens (no ref written during render).
- [x] T040 [US3] FR-035 (partial): `updates.installNow` calls `install_on_quit::verify_installer_before_quit` (bounded) before flagging the relaunch and exiting, returning a `checksum-mismatch`/`update-unavailable` IPC error on failure so Refract stays open.
- [x] T041 [US3] FR-035 (missing): `lib.rs`'s `ExitRequested` handler runs the stop-all and install hand-off once, guarded by a process-global `AtomicBool` quit-in-progress flag.
- [ ] T042 [US3] Verify live on a scratch exe, update `docs/PLAN.md` row #1175, then run `node scripts/ci-local.mjs`.
