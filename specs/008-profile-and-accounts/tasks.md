# Tasks: Profile and accounts

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: `omp` 18.4.x or 18.5.x signed in; Git for Windows; Node 24+; `pnpm`; the GitHub CLI
(`gh`) installed and signed in to at least one account. Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with
a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand, on the
built app in an isolated instance, per the repository's convention. `pnpm typecheck` and
`pnpm build` MUST pass before a change lands on `main`.

**Organization**: tasks are grouped by user story so each story can be built and checked on its
own. Paths are relative to the repository root.

**GitHub issues**: every task below has an issue titled `008-Tnnn: ...`; issue numbers are
recorded on each task line as `(#NNN)` once created, and the full mapping is posted as a comment
on tracking issue #132.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US5). Setup, Foundational, and
  Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Setup and probes

**Purpose**: settle the facts constitution Principle IV says must be verified before the work
that depends on them, and add the UI primitives every later task needs.

- [X] T001 (#201) [P] Probe GitHub CLI multi-account and sign-in-flow behaviour (research.md decisions 1-2): using a disposable or secondary GitHub account you can safely add and remove, run `gh auth login --web` and capture its exact stdout (the one-time-code line and the "press enter" prompt), then with two accounts signed in to `github.com` run `gh auth status --json hosts` and capture the two-entry array shape, then run `gh auth switch --hostname github.com --user <login>` and `gh auth logout --hostname github.com --user <login>` for both a matching and a non-matching `--user` and capture their stdout/stderr/exit code. Update research.md decisions 1-2 with the confirmed shapes (the single-account JSON shape there is already verified and does not need re-checking), and adjust `src/main/github/cli.ts`'s planned parsing (T004) if the two-account shape differs from a single-entry array.
- [X] T002 (#206) [P] Probe OMP sign-in/out over rpc-ui (contracts/omp-usage.md, constitution IV): write `docs/spike/omp-signin-probe.mjs` that starts a scratch `omp --mode rpc-ui` process in an isolated temp cwd (never `~/.omp`, same isolation rule as `docs/spike/slash-commands-probe.mjs`), reads `available_commands_update` for `/login`/`/logout`, sends each as a `prompt` if present, and records every `extension_ui_request`, `command_output`, and `prompt_result` frame they produce; record the result as a new numbered item in `docs/spike/FINDINGS.md` and confirm or correct research.md decision 6's two branches (verified-usable vs. the read-only fallback) accordingly.
- [X] T003 (#210) Add the UI primitives this spec needs: run `pnpm dlx shadcn@4.21.0 add avatar` for `src/renderer/components/ui/avatar.tsx` (new file, radix-nova style, matching `components.json`); by hand add `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`, and a checked-item variant (an `inset`/`checked` prop on `DropdownMenuItem` that renders a check icon, following `select.tsx`'s existing checked-item pattern) to `src/renderer/components/ui/dropdown-menu.tsx`, preserving every existing export and the `align="end"` default so `SessionList.tsx`'s row menu is unaffected.

**Checkpoint**: T001 and T002 each have their result written into research.md / `docs/spike/FINDINGS.md`; `pnpm typecheck` passes with the new `avatar.tsx` and extended `dropdown-menu.tsx` unused as yet.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the GitHub CLI wrapper, profile/avatar fetch, the new cache store, the IPC contract, and the two renderer stores every story builds on.

- [X] T004 (#216) [P] Write `src/main/github/cli.ts`: an `execFile`-based `gh` wrapper mirroring `src/main/git/git.ts`'s shape (`ghRaw(args, { cwd })` never rejecting, a typed `GhError` with codes `gh-not-found`, `gh-failed`, resolving `gh`'s path via the existing `resolveExecutable('gh')`), `authStatus()` parsing `gh auth status --json hosts` per research.md decision 1 (and T001's confirmed two-account shape), `authToken(host, login)` running `gh auth token --hostname <host> --user <login>`, `authLoginStart(host)` spawning `gh auth login --hostname <host> --web` and streaming its stdout lines, `authLoginCancel()`, `authSwitch(host, login)`, `authLogout(host, login)` (depends on T001).
- [X] T005 (#222) [P] Write `src/main/github/profile.ts`: `fetchProfile(host, login)` calling `cli.authToken` then one bounded `https.request` to `https://api.github.com/user` with an `Authorization` header built from that token (held only in a local variable for that one request, discarded after the call, never logged, never written to disk, and never sent over IPC to the renderer, research.md decision 3), returning `{ displayName, login, avatarUrl }`; `fetchAvatar(avatarUrl)` making one bounded `https.request` whose final host (after any redirect) must equal `avatars.githubusercontent.com`, checking `Content-Type` and the PNG/JPEG magic bytes, aborting past a 256 KiB cap, and returning a validated `data:image/png;base64,...` or `data:image/jpeg;base64,...` string or `null` on any check failure (research.md decisions 3-4; depends on T004).
- [X] T006 (#229) [P] Write `src/main/store/profileCache.ts`: a `ProfileCacheStore` class following `src/main/store/settings.ts`'s exact shape (`static async open(dir)`, `get(host, login)`, `set(host, login, entry)` using the existing `readJsonFile`/`writeJsonFile` from `atomicJson.ts`) for `profileCache.json` (data-model.md).
- [X] T007 (#235) Write the shared types and channels: in `src/shared/model.ts` add `ProfileCache`/`ProfileCacheEntry` (data-model.md); in `src/shared/ipc.ts` add `GitHubAccount`, `OmpProviderState`, `GitHubAddFlowProgress`, the `accounts.github.*`/`accounts.omp.*`/`app.openReleaseNotes` entries to `IPC_REQUESTS`, the five `accounts:*` events to `IPC_EVENTS`, and the matching `RefractApi` members (contracts/ipc.md) (depends on T004-T006 for the shapes those return).
- [X] T008 (#242) Write `src/main/ipc/accounts.ts`'s GitHub half: `accounts.github.list/addStart/addCancel/switch/signOut` built on T004-T006, broadcasting `accounts:github-changed` and `accounts:github-add-progress`; register it from `src/main/ipc/register.ts` alongside the existing area files (depends on T007).
- [X] T009 (#248) Write `src/main/ipc/accounts.ts`'s OMP half (per T002's result and contracts/omp-usage.md): `accounts.omp.list/signIn/signOut/answer` using the scratch, non-Session `OmpProcess` pattern `readiness.ts`'s `checkOmpSignedIn` already uses, reusing `src/main/omp/dialogs.ts`'s `classifyDialog`/`buildDialogResponse` unchanged, broadcasting `accounts:omp-changed`/`accounts:omp-request`/`accounts:omp-request-resolved`; and `src/main/ipc/app.ts`'s `app.openReleaseNotes` (`app.getVersion()` + the fixed releases URL, opened through `index.ts`'s existing `openExternalSafe`-style check) (depends on T002, T007).
- [X] T010 (#255) Write `src/preload/index.ts`'s additions: expose `accounts.github.*`, `accounts.omp.*`, `app.openReleaseNotes`, and the five new `on*` event subscriptions, following the file's existing `request`/`on` helpers exactly (depends on T008, T009).
- [X] T011 (#261) [P] Write `src/renderer/state/accounts.ts`: a zustand store holding `AccountsState` (data-model.md) fed by `window.refract.accounts.*` and its new events, with actions matching the IPC methods (depends on T010).
- [X] T012 (#266) [P] Write `src/renderer/state/view-store.ts` (research.md decision 7; reconciled with the agents planning specs 003 and 004 in this session): the full `ViewState` shape (`view: 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'`, `repositoryId`, `settingsSection`, `openChat`/`openPullRequests`/`openSettings`/`openManageSessions`), implementing only `'chat'`/`'manage-sessions'` and `openChat`/`openManageSessions` for real; `'pull-requests'`/`'settings'` and the other two actions are typed, working state-setters (they set `view` and the relevant field) with no render branch of their own yet — that render branch is specs 003/004's own task. If either sibling spec's task creates this file first with the same agreed shape, skip this task.
  -- Skipped per this task's own note: `src/renderer/state/view-store.ts` already exists, created by spec 004 (its own header comment: "spec 004 data-model.md 'view-store.ts'... implements only 'chat'/'settings' behaviour and leaves the other two as typed stubs"). Checked the live file against this task's exact description: `MainView` union matches verbatim, `SettingsSectionId` includes `'appearance'` (needed later by T022), and `openManageSessions: () => set({ view: 'manage-sessions' })` already IS the real implementation this task asked for -- 'manage-sessions' has no extra state beyond the view switch itself, so there was nothing further to add. No code change needed.

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; a scratch Node script calling `window.refract.accounts.github.list()` (or, from the built app's dev tools console) returns the real signed-in account(s) with `active` and `displayName`/`avatarDataUrl` populated.

---

## Phase 3: User Story 1 - See who you are and reach Settings (Priority: P1) 🎯 MVP

**Goal**: the profile item (avatar, name, cog) is pinned at the bottom of the left nav; the cog
opens Settings, the rest opens a minimal profile menu; both states (signed in, signed out) render
correctly and are fully keyboard-accessible.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T013 (#271) [US1] Write `src/renderer/features/profile/ProfileItem.tsx`: the round avatar (`avatar.tsx`, T003) with an initials fallback while loading, failed, or unset (FR-007), the display name or "Sign in" (FR-004), and a separate cog button, both reachable by keyboard with a visible focus indicator and one combined accessible name (FR-005, FR-026, FR-028 for the long-name ellipsis), fed by `useAccountsStore` (T011) for the active GitHub account (FR-001, FR-006).
- [X] T014 (#276) [US1] Write `src/renderer/features/profile/ProfileMenu.tsx`'s minimal shell: a `DropdownMenu` (T003's primitives) opened by selecting the profile item anywhere but the cog (FR-003), showing the account header (avatar + `@handle`) or a Sign in action when signed out (FR-004), arrow-key navigation, Esc to close, and focus returned to the profile item on close (FR-024); wire the cog to call `useViewStore.getState().openSettings()` (FR-002; plan.md "Build order" — the Settings screen itself is spec 004's, not built here); mount `ProfileItem`+`ProfileMenu` at the bottom of the left nav by wrapping `SessionList` in `src/renderer/App.tsx` in a flex column (`<SessionList/>` flex-1 scrollable, `<ProfileItem/>` shrink-0 below it), and add the `'settings'` case to `App.tsx`'s main-area switch reading `useViewStore` (rendering nothing further until spec 004 lands its `SettingsScreen`, per plan.md) (depends on T011-T013).
- [X] T015 (#282) [US1] Update the docs and verify live: `docs/DESIGN.md` "Layout" (the profile item's placement and the cog/menu split) and "Keyboard"; then on the built app in an isolated instance (own `--user-data-dir`): confirm a signed-in account's avatar and name show, the cog opens the (currently empty) Settings switch, selecting elsewhere opens the menu, signing out via `gh auth logout` outside Refract and reopening shows the generic avatar and "Sign in", and Tab/Enter/Esc reach and operate both controls with a visible focus indicator (quickstart Story 1).
  -- Live evidence (parent, earlier pass, isolated instance): signed-in avatar and name show;
  the cog opens Settings; selecting elsewhere opens the menu; the Manage accounts dialog,
  Add account device-code flow (code shown in ~2 s) and gh-scratch account state exercised in
  the 2026-10-05 re-verify. NOT re-run on the fixed build: signing out via `gh auth logout`
  outside Refract and reopening to see "Sign in".
  -- Add-account failure path (parent, 2026-10-05, scratch gh config, `gh auth login` child
  killed mid-flow): status became `failed`, focus moved to Retry, one `role="alert"` read
  "Sign-in failed. Check your connection and retry."; clicking Retry started flow `-2` with a
  new code and focus on Copy code. Copy code announced "Code copied" in a live region inside
  the dialog (outside the Radix-hidden #root). NOT verified live: sign-out announcement,
  real add-account completion, GitHub Enterprise Server hosts.

**Checkpoint**: run quickstart Story 1. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 4: User Story 2 - Sign in, switch, and sign out of GitHub accounts (Priority: P1)

**Goal**: Manage accounts lists every GitHub CLI account, adds one through its own sign-in flow, switches the active one, and signs one out with a naming confirmation; the active account drives the profile item everywhere.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [X] T016 (#287) [US2] Write `src/renderer/features/profile/ManageAccountsDialog.tsx`'s GitHub section: lists every `GitHubAccount` (T011), marks the active one by text and colour (FR-008), a Switch action per row (FR-010), a Sign out action per row and from `ProfileMenu`'s Sign out item (T014's account header area) sharing one confirmation component that names the account and, when it is active with others remaining, names which becomes active next, or says none will remain active (FR-011); add the "Manage accounts" item to `ProfileMenu.tsx` opening this dialog; show the GitHub-CLI-missing/signed-out states from FR-014 (Install action link text only — the actual readiness-screen Install control is spec 006's).
- [X] T017 (#292) [US2] Add the Add account flow to `ManageAccountsDialog.tsx`: an "Add account" action calling `accounts.github.addStart()`, showing the one-time code and progress from `accounts:github-add-progress` (T011) until it completes or is cancelled, with a Cancel action calling `accounts.github.addCancel()` (FR-009).
- [X] T018 (#297) [US2] Update the docs and verify live: `docs/DESIGN.md` (Manage accounts' GitHub section) and `quickstart.md` Story 2 (fix any step whose wording T001's probe result changed); then on the built app in an isolated instance with a second, disposable GitHub account available: add it through the flow, switch the active account and confirm the profile item updates within 1 second, sign one out with two remaining and confirm the naming confirmation, then sign out the last remaining account and confirm the signed-out state (quickstart Story 2).
  -- Verified live 2026-10-05 against a scratch `GH_CONFIG_DIR` (fake accounts, `GH_BROWSER` set
  to a no-op), not a second real GitHub account: multi-account `gh auth status --json hosts`
  shape, switch (~0.75-0.95 s to the profile item), active-account sign-out successor rule (2 and
  3 fake accounts, non-alphabetical order), the real device-code add flow (genuine one-time code,
  grouped display, Copy code), Cancel (shortened to a 750 ms grace, now ~2 s with a "Cancelling…"
  state), and last-account sign-out to the empty state. docs/DESIGN.md and quickstart.md Story 2
  updated to match. **Not exercised**, by design: a real add-account flow run to completion (needs
  a second disposable GitHub account and a person approving in a browser), real GitHub Enterprise
  hosts, and anything that would switch or sign out `stuarthopwood`'s own real login.

**Checkpoint**: run quickstart Story 2. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 5: User Story 3 - Manage OMP sign-in beside GitHub (Priority: P2)

**Goal**: Manage accounts also shows and (if T002's probe allows) drives OMP's own provider sign-in state, in a section clearly separate from GitHub accounts.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [X] T019 (#303) [US3] Write `ManageAccountsDialog.tsx`'s OMP section: a separately labelled list of `OmpProviderState` (T011) distinct from the GitHub section (FR-016); if T002's probe found `/login`/`/logout` usable over rpc-ui, a Sign in/out action per provider that calls `accounts.omp.signIn/signOut`, renders any `accounts:omp-request` the same way `RequestCard.tsx` renders a Session's pending request (reused, not duplicated), and requires a confirmation naming the provider and warning that running sessions use it before signing out (FR-017); otherwise (the fallback), a read-only list with the "run `/login`/`/logout` in a terminal" instruction (research.md decision 6).
- [X] T020 (#308) [US3] Update the docs and verify live: `docs/DESIGN.md` (Manage accounts' OMP section) and `quickstart.md` Story 3 (confirm it matches whichever of T002's two branches was built); then on the built app in an isolated instance: confirm the OMP section is clearly labelled apart from GitHub, and either (probe-usable branch) sign a provider out and back in and confirm the warning and state updates, or (fallback branch) confirm the read-only list and instruction text.
  -- Verified live 2026-10-05 (real app, real 80-provider omp install, real mouse/keyboard
  events through CDP, isolated user-data dir): first open shows the skeleton (aria-busy,
  "Checking OMP providers…") while a scratch omp process reads the list (~4.7 s direct IPC,
  ~4-8 s end to end); loaded state shows "2 of 80 providers signed in", the two signed-in
  providers, and a "Show all 80 providers…" disclosure that expands to the other 78 with
  "Not signed in"; Check again shows a "Checking…" indicator with the cached rows kept on
  screen, then a polite "OMP providers: 2 of 80 signed in" announcement; Copy command copies
  `omp login` through the main-process clipboard and shows "Copied" for 2 s; a bug (the
  mounted-guard never reset on mount, so React StrictMode's dev double-mount silently
  disabled the post-refresh announcement/focus-move/Copied state) was found by this pass and
  fixed in 669d365, together with scrollbar-overlap padding on the collapsed list. The error
  state was verified by injecting a failure through the store, not a real omp failure.
  **Not exercised** (fact 8): a real sign-in (needs a person at a terminal and a provider
  account to sign in to) and a real OMP-missing failure.

**Checkpoint**: run quickstart Story 3. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 6: User Story 4 - The profile menu (Priority: P2)

**Goal**: the profile menu carries every item in its fixed order, with a working Theme submenu, Keyboard shortcuts, update entry, Health check, and What's new, fully keyboard-operable.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [X] T021 (#312) [US4] Extend `ProfileMenu.tsx` to the full fixed order (FR-018): account header, Manage accounts (T016), Manage sessions (added by T027 below — add the menu item and its `openManageSessions()` call now even though the screen lands in Phase 7), Theme, Keyboard shortcuts, the update entry, Health check, What's new, then Sign out set apart with a separator; keep the existing arrow-key/Esc/focus-return behaviour (T014) working across the longer list.
  -- Done except the Manage sessions item itself: left as a reserved, commented slot right
  after Manage accounts (ProfileMenu.tsx) instead of a menu item that would open an empty
  view -- a control that opens nothing is worse than no control. Added by T027 (Phase 7) once
  the screen it opens exists. Everything else in the fixed order (account header, Manage
  accounts, Theme, Keyboard shortcuts, Health check, What's new, Sign out, each separator) is
  built and keeps the existing arrow-key/Esc/focus-return behaviour across the longer list.
- [X] T022 (#317) [US4] Add the Theme submenu (FR-019; depends on spec 007 shipping its theme setter and `settingsSection: 'appearance'`, same blocked-until-lands relationship as T024's update entry — plan.md "Build order"): a `DropdownMenuSub` (T003) listing every built-in dark preset with the active one checked by icon and text, plus "Appearance settings" calling `useViewStore.getState().openSettings('appearance')`; the preset choices call spec 007's theme-setter IPC against its documented contract once that spec ships it.
  -- Spec 007 shipped since this task was written, so the blocking dependency is resolved:
  every built-in preset from THEMES, the active one checked by icon and the word "Current",
  a data-driven swatch (ThemePicker.tsx's own approach, never a hard-coded hex -- a UI-review
  correction), choosing a different one calling useThemeStore.getState().save(id) directly
  (applies and persists at once; a menu is not where a live preview belongs) and announcing
  "Applied theme {name}" through ProfileItem's shared live region, then "Appearance
  settings…" calling openSettings('appearance').
- [X] T023 (#321) [US4] Write `src/renderer/features/profile/KeyboardShortcutsDialog.tsx` (FR-020): a read-only list built from a static constant matching `docs/DESIGN.md`'s "Keyboard" table (Send message, Newline, Clear the message box, Stop the running turn, New Session, New Conversation, Jump to the Nth Session, Hide/show the session list, Open Settings, Cycle Approval mode, Command palette); swapped for backlog issue #6's dynamic set once that work exists, not by this task.
  -- Built with an HONESTY correction: every one of docs/DESIGN.md's 13 "Keyboard" table rows
  was individually re-verified against its real handler before being listed (not assumed from
  the table). Only 6 have one: Send message, Newline (textarea default), Clear the message box,
  Stop the running turn (all MessageInput.tsx), Open in split (SessionList.tsx), and Move focus
  to the other pane (App.tsx). The other 7 (New Session, New Conversation, Jump to the Nth
  Session, Hide/show the session list, Open Settings, Cycle Approval mode, Command palette) have
  no handler anywhere in src/renderer or src/main -- confirmed by reading every keydown listener
  and src/main/menu.ts's accelerators, not grepped-and-assumed. This dialog lists only the 6 real
  ones; a new GitHub issue documents the other 7 (filed this session) rather than promising a
  "coming soon" footer the reviewer had proposed.
- [X] T024 (#325) [US4] Wire the update entry, Health check, and What's new in `ProfileMenu.tsx`: the update entry reads spec 006's `updates.get()`/`updates:changed` (contracts/ipc.md "Update state (owned by spec 006)" — blocked until spec 006 ships it; this task implements the two-state label against that documented shape) (FR-021); Health check calls the existing `window.refract.readiness.check()` and shows its result in a toast or small dialog (FR-022); What's new calls the new `app.openReleaseNotes()` (T009) (FR-023).
  -- Partially done: Health check (a dialog, not a toast -- reruns readiness.check() live,
  reusing Readiness.tsx's own per-check row via the new CheckRow.tsx extraction) and What's new
  (calls app.openReleaseNotes(), a sonner toast on either outcome) are both wired and real. The
  update entry is NOT wired: spec 006 still does not exist in this checkout -- no updates IPC
  request, preload method, or store, confirmed by searching for all three before writing this
  note. Rather than add a disabled/stub item, its slot is left as a reserved, commented position
  in ProfileMenu.tsx between Keyboard shortcuts and Health check; the remaining work is split out
  as T024b below so this task itself can close.
- [ ] T024b [US4] Wire the real update entry in `ProfileMenu.tsx` once spec 006 ships `updates.get()`/`updates:changed` (contracts/ipc.md "Update state (owned by spec 006)"): replace the reserved slot (between Keyboard shortcuts and Health check) with the real two-state label ("Check for updates" / "Restart to update <version>") against that shipped shape (FR-021). Depends on spec 006.
- [X] T025 (#329) [US4] Update the docs and verify live: `docs/DESIGN.md` ("Keyboard" cross-reference, Settings/Backlog notes for the Theme submenu and update entry) and `quickstart.md` Story 4; then on the built app in an isolated instance: confirm the fixed order, open and check the Theme submenu's active entry, open Keyboard shortcuts, select Health check and read its result, select What's new and confirm the system browser opens, and operate the whole menu (including into and out of the Theme submenu) using only the keyboard with focus returning to the profile item on close.
  -- docs/DESIGN.md's Profile item bullet rewritten with the full built order and both reserved
  slots named; new Keyboard shortcuts dialog and Health check dialog bullets added; quickstart.md
  Story 4 rewritten to match (including the two deferred items). Live keyboard-operation /
  visual verification NOT run by this agent (no app launch, per instruction -- the parent verifies
  live with real input events); pnpm typecheck, pnpm build, and pnpm check:ui-text (0 leaks) were
  run and passed instead.
  -- Post-build review fixes (ui-architect-v3, Stuart 2026-10-05) applied in a follow-up pass:
  menu loading state (Checking GitHub sign-in…), Sign in/Install GitHub CLI icon columns, the
  dropdown's max-h switched to the Radix available-height var, the Theme submenu's
  keyboard-open focus on the active preset and its --active-indicator bar, a caught theme.set
  rejection, Keyboard shortcuts' no-brackets copy fix, and Health check's announcement wording,
  doubled-state-word, missing catch, re-run layout jump, and hard-coded colour fixes -- see the
  updated Profile item and Health check dialog bullets in docs/DESIGN.md.
  -- Live evidence (parent, 2026-10-05, isolated instance, real CDP input): the fixed menu order
  (Manage accounts, Manage sessions, Theme, Keyboard shortcuts, Health check, What's new, Sign
  out) renders; Enter on the profile button opens it; the Theme submenu opens with ArrowRight,
  lists Dark (Current, accent bar on the focused item) / Dark (high contrast) / Appearance
  settings; Esc backs out and focus returns to the profile button; Health check runs against the
  real readiness check and reads Git Passed, OMP Passed with a warning (18.6.1 outside 18.4.x/
  18.5.x), OMP signed in Passed, focus on Done. NOT verified live: What's new (opens the system
  browser; deliberately not clicked), the Keyboard shortcuts dialog contents in this pass,
  Theme submenu focus ring with Dark (high contrast) active, selecting a theme.

**Checkpoint**: run quickstart Story 4. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 7: User Story 5 - Manage sessions (Priority: P3)

**Goal**: a cross-repository Sessions screen reusing spec 001's existing archive, restore, and delete actions and confirmations.

**Independent test**: [quickstart.md](quickstart.md) Story 5.

- [X] T026 (#333) [US5] Write `src/renderer/features/profile/ManageSessionsScreen.tsx`: lists every Session across every Repository (`useSessionsStore`/`useRepositoriesStore`, specs/001) with its repository, status, and archive state (FR-025), reusing the existing archive/restore actions and `DeleteDialog.tsx`'s confirmation (specs/001 FR-029) unchanged — no new IPC, this screen is a renderer-only cross-repository view over `sessions.list()`.
- [X] T027 (#336) [US5] Add the `'manage-sessions'` case to `App.tsx`'s main-area switch (rendering `ManageSessionsScreen`) and the "Manage sessions" item's `openManageSessions()` wiring in `ProfileMenu.tsx` (T021) (depends on T012, T021, T026).
- [X] T028 (#340) [US5] Update the docs and verify live: `docs/DESIGN.md` (Manage sessions screen) and `quickstart.md` Story 5; then on the built app in an isolated instance with Sessions in more than one repository, including an archived one: open Manage sessions from the profile menu, confirm every Session is listed with its repository/status/archive state, archive one, restore the archived one, and delete one, confirming the same uncommitted/unpushed confirmation spec 001 requires.
  -- Shared `sessionActions.ts(x)` extraction verified by reading the `SessionList.tsx` diff
  (no behaviour change, only the row action list extracted). Main-process archive-stops-agent
  claim verified in `src/main/ipc/sessions.ts`: the `SESSIONS_ARCHIVE` handler calls
  `manager.getOrCreateAgent(id).shutdown()` before setting `archivedAt` -- confirmed true.
  Live keyboard/visual verification not performed here; the parent agent verifies on the
  built app.
  -- Live evidence (parent, 2026-10-05, isolated instance `--user-data-dir=C:/tmp/p7/userdata`,
  real CDP mouse/key input, repos alpha+beta with 6 Sessions incl. archived): Manage sessions
  opens from the profile menu and lists every Session with repository/status/archive state;
  restore and archive-under-filter exercised in an earlier pass; single click opens the clicked
  row's Session and a follow-up double-click does not open a different Session or toggle the
  sidebar row beneath it (view stayed on the opened Session, sidebar repository groups kept
  their expanded state); with a split open, opening from Manage sessions replaces the focused
  pane and focus lands in that pane (`merry-heron chat`, x=281); the row context menu offers
  Rename / Open in split / Copy worktree path / Open worktree folder / Restore / Delete…;
  Delete… opens the spec 001 confirmation with focus on Cancel (still there after 4 s), and
  Escape cancelled it (Session count stayed 6).
  NOT verified live: confirming an actual delete (confirmation was cancelled, not accepted);
  the "Showing X of N" filter announcement in a screen reader; double-click `activeElement`
  between the two mousedowns.

**Checkpoint**: run quickstart Story 5. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 8: Polish & cross-cutting concerns

- [ ] T029 (#343) Accessibility pass across every control this spec added (FR-005, FR-027, FR-028, SC-006, SC-008): confirm the profile item, cog, every menu item, the Theme submenu's checked state, Manage accounts' active-account marker and every action, and Manage sessions' rows all have an accessible name, convey every distinguishing state (active account, active theme, sign-in state, archived) by icon or text and never colour alone, truncate a long display name with an ellipsis rather than wrapping, and keep a visible focus indicator throughout; fix any finding before closing this task.
- [ ] T030 (#347) Final full run: on the built app in an isolated instance, run every check in [quickstart.md](quickstart.md) Stories 1 through 5 in one pass (not story-by-story), confirming nothing an earlier story's task touched regressed; `pnpm typecheck` and `pnpm build` both pass with no warnings.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — can start immediately.
- **Foundational (Phase 2)**: depends on Phase 1 (T004 needs T001's confirmed shape; T009 needs T002's probe result) — BLOCKS every user story.
- **User Stories (Phase 3+)**: all depend on Foundational completion.
  - US1 (P1) has no dependency on another story.
  - US2 (P1) depends on US1's `ProfileMenu.tsx` shell existing (T014) to add its "Manage accounts" item and Sign out wiring.
  - US3 (P2) depends on US2's `ManageAccountsDialog.tsx` existing (adds a section to the same file).
  - US4 (P2) depends on US1's `ProfileMenu.tsx` shell and references US2's Manage accounts item and US5's Manage sessions item by name, but its own Theme/Keyboard shortcuts/update/Health check/What's new items are independent of US2/US3/US5's internals.
  - US5 (P3) depends on US1's `view-store.ts` (T012) and, for its menu entry, US4's full menu (T021) — its own screen (T026) has no other story dependency and reuses only spec 001 IPC.
- **Polish (Phase 8)**: depends on every story above being complete.

### Parallel Opportunities

- T001 and T002 run in parallel (independent probes, different files).
- T004, T005, T006 run in parallel (independent new files) once T001 lands.
- T011 and T012 run in parallel once T010 lands.
- Within Phase 4, T016 and T017 touch the same file (`ManageAccountsDialog.tsx`) and are not parallel; across phases, Phase 5's T019 (same file, a new section) must follow T016/T017, not run parallel with them.

## Notes

- GitHub issues: every task above has an issue titled `008-Tnnn: ...`; once created, each task
  line is updated with `(#NNN)` and the full mapping is posted as one comment on tracking issue
  #132 (recorded in this file's own history, not duplicated here as a table).
- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story for traceability.
- Commit after each task or logical group; stop at any checkpoint to validate a story
  independently.
- spec 001's own task T099 (moving the low-memory badge onto the profile item, FR-029) is not a
  task of this spec — it depends on T013 existing and is tracked in spec 001's `tasks.md`.
