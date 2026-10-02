# Implementation Plan: Installer and updates

**Branch**: `006-installer-and-updates` (no branch created; work lands on `main`) | **Date**: 2026-10-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-installer-and-updates/spec.md`

## Summary

Package Refract as a single, per-user, no-admin NSIS installer (electron-builder) with Desktop and
Start Menu shortcuts, a Windows Apps & Features entry, and in-place upgrade; add Install actions
for Git, OMP (pinned to the supported `18.4.x` line), and the optional GitHub CLI to the existing
first-run readiness screen; add an update engine that checks private GitHub Releases through the
developer's own signed-in `gh` CLI (no stored token), downloads and checksum-verifies an update,
and installs it only at the developer's own next normal quit, never interrupting a running agent;
add a keep-or-delete-data uninstaller; and add a maintainer CI workflow that builds and publishes a
tagged release. Design rationale and every sourced/verified/unverified claim is in
[research.md](research.md); the new entities are in [data-model.md](data-model.md); the new IPC
surface is in [contracts/ipc.md](contracts/ipc.md).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1 (unchanged from spec 001).

**Primary Dependencies**: `electron-builder` 26.15.3 (new devDependency, NSIS Windows target, research.md decision 1). No new runtime dependency: checksums use Node's built-in `crypto`; version comparison is hand-written (research.md decision 9); GitHub access goes through the `gh` CLI, an external tool, not an npm package.

**Storage**: one new JSON file in `userData`, `updateState.json`, atomic writes via the existing `src/main/store/atomicJson.ts` helper (data-model.md). `registry.json` and `settings.json` are untouched by this spec.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is verified by running the packaged app per [quickstart.md](quickstart.md). Typecheck and production build must pass before a change lands on `main`.

**Target Platform**: Windows 11 only (installer and updater are Windows-specific; no other platform is in scope).

**Project Type**: desktop-app (Electron: main, preload, renderer) — same project as spec 001, extended, not a new project.

**Performance Goals**: from the spec: a newer version is knowable within 5 s of opening the app or its update control (SC-004); the startup update check adds no observable delay to showing the window (FR-020, SC-010); a dependency Install action's checklist re-check happens as soon as the vendor installer exits, with no manual refresh (SC-003).

**Constraints**: no admin elevation requested by Refract itself anywhere in install, dependency install, update, or uninstall (FR-001, FR-011); no GitHub token ever stored or read by Refract's own code (FR-012, Assumptions; same stance as spec 003 FR-027); an update never installs outside a normal quit the developer already chose, and never while any agent is mid-turn in the sense of forcing one (FR-015; spec 001 FR-031 already stops every agent on quit).

**Scale/Scope**: one maintainer publishing occasional releases; one developer per installed copy; 27 requirements across 5 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.7.1.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass | This spec never changes how a Session drives OMP; it only installs/updates the Refract binary around it, and installs OMP itself from the outside (a separate process, never embedded, consistent with "Refract MUST NOT embed the OMP SDK"). The pinned-18.4.x Install action (research.md decisions 6 to 7) reinforces, rather than loosens, the existing OMP-version gate in `src/main/readiness.ts`. |
| II. RPC wire contract | Pass (not touched) | No change to any frame, request, or dialog handling. |
| III. Session and process lifecycle | Pass | The update install-on-quit step runs only after Refract's own `before-quit` handling (which already stops every agent, spec 001 FR-031) has completed; it never races a live `omp` process, and it does not touch the Job Object or pid-record mechanisms. |
| IV. Evidence before design | Pass, with five first-task gates | Five OMP/Electron/GitHub-CLI/Windows behaviours this spec relies on are not yet verified in this repository and are each a first-phase task before the story that depends on them: OMP's install-script pin/unattended behaviour (T001), Git/GitHub-CLI silent installs (T002), the packaged NSIS installer's no-admin/Apps-entry/in-place-upgrade behaviour (T003), the custom uninstall page and running-instance guard (T004), and `gh release download`/`view` against a private repository (T005). Where a vendor's own documentation already answers part of a question (OMP's actual install script, read directly; Git for Windows' and electron-builder's own docs), research.md cites the exact source and still schedules the probe for the part reading alone cannot confirm (research.md decisions 1, 2, 6). |
| V. Electron security baseline | Pass | Every new network call (vendor installer downloads, `gh` calls, release-asset downloads) happens in the main process only; the renderer only ever sees `Readiness`, `DependencyInstallProgress`, and `UpdateState` values over the existing typed, allowlisted IPC (contracts/ipc.md), never a URL or a file path it could act on directly. Every spawned executable (`gh`, the downloaded vendor installers, the downloaded update installer, `msiexec`) is resolved the same way the app already resolves `git`/`omp` (`src/main/process/executables.ts`'s `resolveExecutable`, never a bare name). Release notes open only through the existing `openExternalSafe` path; no window ever loads remote content. |
| Platform and Stack | Pass | Windows 11 only, matching the constitution; packaging code is new files under `src/main/update/` and `src/main/dependencyInstall.ts`, isolated the same way `src/main/process/` isolates the existing Windows-specific Job Object code. |
| Development Workflow | Pass | Spec Kit order; no automated tests; typecheck and build gate; this plan adds one new gate item, `pnpm package` (electron-builder), which must also succeed before the story-closing live verification in each phase. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/006-installer-and-updates/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions and what is verified
├── data-model.md         # Release, Dependency, DependencyInstallProgress, UpdateState
├── quickstart.md         # how to package, run, and verify each story
├── contracts/
│   └── ipc.md            # additions to spec 001's renderer-to-main contract
├── checklists/requirements.md
└── tasks.md               # produced by /speckit.tasks
```

### Source code (repository root)

```text
package.json                  # + "package" script, electron-builder devDependency, "build" config
electron-builder.yml           # NSIS target config (research.md decision 1)
build/
├── installer.nsh              # customUnInstall (keep/delete data) + customUnInit (close-first guard)
└── icon.ico                   # placeholder pending issue #91 (research.md decision 12)
.github/workflows/
└── release.yml                 # maintainer publish action (research.md decision 8)
src/
├── shared/
│   ├── ipc.ts                 # + Readiness.github, Update*/Dependency* types, new requests/events (contracts/ipc.md)
│   └── model.ts               # unchanged (UpdateState lives only in updateState.json, not in Session/Repository)
├── main/
│   ├── readiness.ts           # + checkGithubCli()
│   ├── dependencyInstall.ts    # new: installGit(), installOmp(), installGithubCli()
│   ├── update/
│   │   ├── UpdateChecker.ts    # gh release list/view, version compare, availability
│   │   ├── UpdateInstaller.ts  # gh release download, checksum verify
│   │   └── installOnQuit.ts    # detached wait-for-pid-exit then silent install
│   ├── store/
│   │   └── updateState.ts      # updateState.json (atomicJson.ts, same pattern as registry.ts/settings.ts)
│   └── ipc/
│       ├── readiness.ts        # + installDependency request, install-progress event
│       └── updates.ts          # new: check/getState/install, app.getVersion
└── renderer/
    └── features/
        ├── readiness/
        │   └── Readiness.tsx    # + Install buttons, GitHub CLI row (optional)
        └── status-bar/
            └── StatusBar.tsx    # + update badge and Check-for-updates action (research.md decision 11)
```

**Structure Decision**: no new project; every new file sits inside spec 001's existing
`src/main`, `src/shared`, `src/renderer` layout, following the same area-folder convention
(`src/main/update/` beside the existing `src/main/omp/`, `src/main/git/`, `src/main/process/`).
Packaging config (`electron-builder.yml`, `build/`) and the CI workflow sit at the repository root
and `.github/workflows/`, where `issue-triage.yml` already lives.

## Design overview

- **Three independent engines, one pattern.** Dependency installs (`dependencyInstall.ts`), the
  update checker/installer (`update/`), and the existing readiness checks (`readiness.ts`) all
  follow the same shape already established by spec 001: a plain async function in main, never
  throwing, reporting `{ ok, hint }` or a progress event instead.
- **`gh` is the only GitHub client.** Nothing in this spec calls the GitHub REST/GraphQL API
  directly or stores a credential; every GitHub read or download is a `gh` subcommand, resolved via
  the existing `resolveExecutable('gh')`.
- **State the developer can't lose.** `updateState.json` persists every step past "available", so a
  crash or an unexpected shutdown never strands a half-downloaded or half-installed update; the
  very next normal quit or app start picks up exactly where it left off (data-model.md "Phase
  transitions").
- **Never Refract's own elevation.** Every spawned installer in this spec (Git's, the GitHub CLI's,
  OMP's, Refract's own update) is run with the most unattended, least-privileged flag set research
  could find; where a vendor's own installer might still elevate, FR-011 already allows it and the
  UI never pretends Refract itself asked.
- **One badge today, two homes tomorrow.** The update badge is built once, against the `updates.*`
  API, and rendered from the one surface that exists today (`StatusBar.tsx`); spec 004's Settings
  screen and spec 008's profile menu are cross-spec dependencies that add their own entries against
  the same API later, not tasks of this spec (research.md decision 11).

## Phase 1 re-check (post-design)

The data model, contracts, and quickstart introduce no new renderer capability beyond
`Readiness.github`, `DependencyInstallProgress`, and `UpdateState` values flowing over the existing
typed IPC channel shape; no new native module, no new always-on background network client beyond
the existing low-memory sampler's timer pattern. The Constitution Check above stands unchanged.

## Complexity Tracking

None.
