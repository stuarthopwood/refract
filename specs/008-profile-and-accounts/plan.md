# Implementation Plan: Profile and accounts

**Branch**: `008-profile-and-accounts` (no branch created; work lands on `main`) | **Date**: 2026-10-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-profile-and-accounts/spec.md`

## Summary

Add a profile item pinned at the bottom of the left nav (avatar, display name, a separate cog)
that opens the Settings screen (cog) or a profile menu (everything else). The menu covers GitHub
account management (list, add, switch, sign out, via the developer's own signed-in GitHub CLI,
never a stored token), OMP's own provider sign-in state, a cross-repository Manage sessions
screen, a Theme submenu, a static Keyboard shortcuts list, the update entry, Health check, and
What's new. The active GitHub account's avatar and profile are fetched by the main process only,
validated, cached, and handed to the renderer as a local data URL (constitution V); GitHub
sign-in, switch, and sign-out all go through the GitHub CLI, never a stored token. Design
rationale and the two probe results are in [research.md](research.md); the two interface
contracts are in [contracts/](contracts/).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1; React 19.3.0 in the renderer. Same stack as spec 001; no version change.

**Primary Dependencies**: No new npm dependency. Uses the developer's own `gh` (GitHub CLI) binary, resolved via the existing `resolveExecutable` helper (`src/main/process/executables.ts`), the same pattern as `git`. Reuses `OmpProcess` (`src/main/omp/OmpProcess.ts`) for the OMP provider section, the same ad hoc scratch-process pattern `readiness.ts`'s `checkOmpSignedIn` already uses. Adds the `avatar` shadcn primitive and extends the existing, repository-owned `dropdown-menu.tsx` with `Sub`/`SubTrigger`/`SubContent` and a checked-item variant (needed for the Theme submenu's check mark, FR-019); no other new UI library.

**Storage**: one new JSON file in `userData`, `profileCache.json` (data-model.md), atomic writes via the existing `atomicJson.ts` helper. No change to `registry.json` or `settings.json`: GitHub accounts and OMP provider state are never stored by Refract (FR-012) — only the display name, handle, and avatar *cache* for offline display (FR-015) is.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is verified by running the app per [quickstart.md](quickstart.md). Typecheck and production build must pass before a change lands on `main`.

**Target Platform**: Windows 11 only.

**Project Type**: desktop-app (Electron: main, preload, renderer) — same project as spec 001, no new source root.

**Performance Goals**: from the spec: active-account switch reflected on the profile item within 1 s (SC-002); the subagent... n/a (not this spec). Manage accounts' account list and the OMP section both read live state on open, no artificial delay.

**Constraints**: no stored GitHub access token (FR-012); the avatar fetch is the one main-process network image download in the app, bounded to `avatars.githubusercontent.com`, validated as a small PNG or JPEG before use (FR-006, FR-007, constitution V); the renderer never loads a remote image or calls GitHub directly; OMP sign-in management over Refract's existing RPC connection is unverified until the Phase 1 probe runs (constitution IV).

**Scale/Scope**: a handful of GitHub accounts (typically 1-3), one to a few OMP providers; 29 requirements across 5 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.7.1.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass | The OMP provider section (User Story 3) only reuses the existing `omp --mode rpc-ui` launch Refract already drives (same flags, same `OmpProcess`); it adds no new launch mode, flag, or SDK/ACP path. |
| II. RPC wire contract | Pass | Sign-in/out prompts (`/login`, `/logout`) and `get_login_providers` are sent on the same `message`/`prompt` and `extension_ui_request` wire contract spec 001 already implements; no literal `/btw`; every dialog answered or cancelled; the probe (Phase 1) confirms these two commands actually exist before the implementation tasks rely on them. |
| III. Session and process lifecycle | Pass | The OMP provider probe process is a scratch, non-Session `OmpProcess` in a temp cwd (same pattern as `readiness.ts`'s `checkOmpSignedIn`), started on demand when Manage accounts' OMP section opens and stopped when it closes or the action finishes; it is not a Session, is never persisted, and is covered by the same kill-on-close Job Object every `omp` child joins. |
| IV. Evidence before design | Pass, with two named gates | GitHub CLI structured output (`gh auth status --json hosts`, `gh auth token`, `gh auth login/switch/logout --help`) was verified live on the planning workstation (single-account case); the two-or-more-account shape and the exact `gh auth login --web` one-time-code text are scheduled as task T001 (Phase 1), before User Story 2 depends on them. Whether OMP's own sign-in/out can be driven and its provider state read over Refract's existing RPC connection (User Story 3) is unverified per the spec's own Assumptions; task T002 (Phase 1) probes it and records the result in `docs/spike/FINDINGS.md` before any User Story 3 task relies on it. |
| V. Electron security baseline | Pass | The renderer never makes a GitHub request or loads a remote image: the main process fetches the account profile (via `gh auth token` + a bounded `https` call to `api.github.com`, never stored) and the avatar (bounded to `avatars.githubusercontent.com`, validated as a small PNG/JPEG, cached), and hands the renderer only a `data:` URL. The What's new entry opens the system browser through the existing `openExternalSafe`-style check, never in-app. |
| Platform and Stack | Pass | Windows 11 only; no new source root; `gh` resolved the same way `git`/`omp` are (`executables.ts`), never a bare name. |
| Development Workflow | Pass | Spec Kit order; no automated tests; typecheck and build gate; each story verified by running the built app. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/008-profile-and-accounts/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions, the two probe results
├── data-model.md        # profileCache.json, derived GitHub/OMP account views
├── quickstart.md         # how to run and verify each story
├── contracts/
│   ├── ipc.md            # renderer to main API this spec adds
│   └── omp-usage.md       # the OMP provider section's wire usage (User Story 3)
├── checklists/requirements.md
└── tasks.md              # produced by /speckit.tasks
```

### Source code (repository root, additions only — spec 001's tree is unchanged elsewhere)

```text
src/
├── shared/
│   ├── ipc.ts                      # + GitHubAccount, OmpProviderState, ManagementPendingRequest,
│   │                                #   new accounts.*/app.* channels (contracts/ipc.md)
│   └── model.ts                    # + ProfileCache (data-model.md)
├── main/
│   ├── github/
│   │   ├── cli.ts                  # gh wrapper: authStatus, authToken, authLoginStart/Cancel, authSwitch, authLogout
│   │   └── profile.ts              # profile (gh auth token + bounded api.github.com) and avatar (bounded
│   │                                #   avatars.githubusercontent.com, validated, cached) fetch
│   ├── store/
│   │   └── profileCache.ts         # profileCache.json (data-model.md), same atomicJson.ts pattern as settings.ts
│   └── ipc/
│       └── accounts.ts             # accounts.github.* and accounts.omp.* handlers; app.openReleaseNotes
├── preload/
│   └── index.ts                    # + accounts.github.*, accounts.omp.*, app.openReleaseNotes, new event subscriptions
└── renderer/
    ├── state/
    │   ├── accounts.ts             # zustand: GitHub accounts, add-flow progress, OMP providers
    │   └── view-store.ts            # extends the shared main-area view-switch store (see research.md
    │                                 #   decision 7); this spec adds the 'settings' and 'manage-sessions'
    │                                 #   views and the actions that open them
    ├── features/
    │   └── profile/
    │       ├── ProfileItem.tsx            # US1: bottom-of-left-nav item + cog
    │       ├── ProfileMenu.tsx            # US4: the menu, fixed order, Theme submenu, keyboard nav
    │       ├── ManageAccountsDialog.tsx   # US2 (GitHub section) + US3 (OMP section)
    │       ├── ManageSessionsScreen.tsx   # US5: cross-repository session list
    │       └── KeyboardShortcutsDialog.tsx # US4: static shortcut list
    └── App.tsx                      # + mounts ProfileItem under SessionList; + 'settings'/'manage-sessions'
                                      #   cases in the view-switch render (same slot `showReadiness` uses today)
```

**Structure Decision**: same one-project Electron layout as spec 001 (`main`, `preload`, `renderer`, `shared`); this spec adds one new main-process area (`src/main/github/`), one new IPC area (`src/main/ipc/accounts.ts`), and one new renderer feature folder (`src/renderer/features/profile/`). No new source root, no new npm dependency.

## Design overview

- **GitHub sign-in stays entirely in the developer's own GitHub CLI.** Refract never stores a
  token (FR-012): `src/main/github/cli.ts` only ever shells out to `gh`, and
  `src/main/github/profile.ts` reads a short-lived token via `gh auth token --hostname <h> --user
  <login>` to make one bounded `https` call per account, then discards it — it is never written
  to disk or kept beyond that one call.
- **One cache, two purposes.** `profileCache.json` holds the last-known display name and avatar
  per account, keyed by `host/login`. It answers FR-015 (offline fallback) and avoids refetching
  on every menu open; it is refreshed opportunistically (account list changes, app start for the
  active account, lazily for others when Manage accounts opens), never on a timer.
- **The avatar is the one network image fetch in the app.** `profile.ts` validates the response's
  final host (after any redirect), content type, and magic bytes before accepting it, and caps its
  size; a validated avatar becomes a `data:` URL handed to the renderer, never a URL it could load
  itself (constitution V).
- **OMP's provider section reuses a proven pattern, not a new one.** `readiness.ts`'s
  `checkOmpSignedIn` already spins up a scratch, non-Session `OmpProcess` to call
  `get_login_providers`; the OMP section of Manage accounts reuses the same construction for
  reads, and — once the Phase 1 probe confirms it is possible — for driving `/login`/`/logout` and
  relaying whatever `extension_ui_request` dialogs they raise through the existing `dialogs.ts`
  classifier (contracts/omp-usage.md).
- **One shared view-switch store, not three.** `src/renderer/state/view-store.ts` is a primitive
  three sibling specs need at once (spec 003's Pull requests view, spec 004's Settings screen,
  this spec's Settings-cog and Manage sessions screen). Reconciled live with the agents planning
  specs 003 and 004 in this same session (research.md decision 7): one store,
  `view: 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'`, `repositoryId` (spec 003's
  field), `settingsSection` (spec 004's field), and `openChat`/`openPullRequests`/`openSettings`/
  `openManageSessions` actions. This spec's tasks add the `'manage-sessions'` case and call
  `openSettings()` from the cog and `openManageSessions()` from the profile menu; whichever of the
  three specs lands the file first creates it with the full four-way union already in place, and
  the others' tasks become additive, not conflicting.

## Build order and dependencies on other specs

- **Independently completable now**: User Story 1 (profile item), User Story 2 (GitHub accounts),
  and User Story 5 (Manage sessions) depend on no other spec's code landing first — Manage
  sessions reuses spec 001's already-shipped `sessions.list`/`archive`/`restore`/`deleteCheck`/
  `delete` IPC directly.
- **Depends on spec 004 (Session readout and Settings)**: FR-002 (the cog opens Settings) depends
  on spec 004 shipping `SettingsScreen.tsx` and the `view-store.ts` primitive above (confirmed
  live with that spec's planning agent, this session). Until spec 004 lands, this spec's cog task
  still implements the `openSettings()` call correctly; the screen it switches to simply does not
  exist yet. Whichever of specs 004/008 is implemented first creates `view-store.ts`; the other
  extends it.
- **Depends on spec 003 (Pull request management)**: no direct dependency, but `view-store.ts` is
  shared with it per the same reconciliation; a conflicting shape would need to be re-resolved
  before either spec's `view-store.ts` task runs.
- **Depends on spec 006 (Installer and updates)**: the profile menu's update entry (FR-021) reads
  spec 006's update state ("Restart to update" vs "Check for updates"); spec 006 has not yet
  defined that IPC contract. This spec's task implements the menu item against the shape
  documented in contracts/ipc.md ("Update state (owned by spec 006)") and is blocked on spec 006
  shipping it; until then the entry can be built and visually checked but not end-to-end verified.
- **Depends on spec 007 (App themes)**: the profile menu's Theme submenu (FR-019) and its "More
  themes" entry depend on spec 007's theme setter and its `view-store.ts` `settingsSection:
  'appearance'` value. Same blocked-until-lands relationship as the update entry.
- **spec 001 T099 depends on this spec**: spec 001's existing task T099 ("move the low-memory
  warning from the status bar to the profile item", FR-056, FR-037) is already written in spec
  001's own `tasks.md` and explicitly waits for this spec's profile item (FR-029) to exist; it is
  spec 001's task, not duplicated here. This spec's `ProfileItem.tsx` (T0xx below) is written so a
  badge can be added to it later without restructuring.
- **spec 003's active-account consumer**: FR-013 (pull request management and update checks use
  the active GitHub account) is satisfied by this spec exposing `accounts.github.list()` with an
  `active` flag; spec 003 and spec 006's own tasks are responsible for reading it at the start of
  each request and finishing in-flight requests with the account they started with.

## Complexity Tracking

None.
