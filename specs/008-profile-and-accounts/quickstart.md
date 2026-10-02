# Quickstart: verifying profile and accounts

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/](contracts/).

## Prerequisites

- Windows 11, `omp` 18.4.x on `PATH` and signed in (same as specs/001's quickstart).
- The GitHub CLI (`gh`) installed and signed in to at least one account (`gh auth status`). For
  User Story 2's switch/sign-out checks, a second GitHub account you can safely add and remove
  (`gh auth login --web`) is needed — use a disposable or secondary account, not your only one.
- `pnpm install`, `pnpm dev` (or `pnpm build` then run `out/main/index.js`'s packaged app).

## Run

```
pnpm install
pnpm dev          # Electron with hot reload
pnpm typecheck    # must pass before a change lands on main
pnpm build        # must pass before a change lands on main
```

## Checks per story

**Story 1: see who you are and reach Settings (FR-001 to FR-007)**

1. With a GitHub account signed in, look at the bottom of the left nav. Expect: a round avatar,
   that account's display name, and a separate cog button.
2. Select the cog. Expect: the Settings screen opens (spec 004; until that spec lands, the main
   area simply switches away from chat with nothing further to show yet — the switch itself is
   what this story checks).
3. Select the profile item anywhere else. Expect: the profile menu opens, not Settings.
4. Sign out of the GitHub CLI (`gh auth logout`) outside Refract, then look at the profile item.
   Expect: a generic avatar and "Sign in" in place of a name; opening the menu offers Sign in.
5. Using only the keyboard, Tab to the profile item and to the cog. Expect: both take focus with
   a visible indicator, in that order, and a screen reader reads each as one phrase naming the
   sign-in state.
6. Temporarily break network access (or point `avatars.githubusercontent.com` at an unreachable
   address via the hosts file) and restart Refract while already signed in to GitHub. Expect: the
   last cached display name and avatar show, not an error or a blank circle.

**Story 2: sign in, switch, and sign out of GitHub accounts (FR-008 to FR-015)**

1. Open Manage accounts. Expect: every GitHub CLI account is listed, the active one marked by
   text and colour.
2. Choose Add account. Expect: the system browser opens through the GitHub CLI's own device flow,
   and Manage accounts shows the one-time code and progress until you complete it in the browser.
3. With two accounts signed in, switch the active one. Expect: it becomes active immediately, and
   the profile item's name and avatar update within 1 second (SC-002).
4. Sign one account out while two remain. Expect: a confirmation naming that account and which
   account becomes active next; confirming signs it out and makes the named account active.
5. Sign out the one remaining account. Expect: the confirmation says no account will remain
   active; confirming returns the profile item and menu to the signed-out state (Story 1).
6. Run `gh auth logout` for every account outside Refract, or uninstall the GitHub CLI from PATH,
   then look at the profile item and Manage accounts. Expect: both say so, offering Sign in (CLI
   present) or the Install action from the readiness screen (CLI missing, spec 006).

**Story 3: manage OMP sign-in beside GitHub (FR-016, FR-017 — unverified until the Phase 1 probe)**

1. Open Manage accounts. Expect: a separate, labelled OMP section lists every provider OMP is
   signed in to, distinct from the GitHub section.
2. If the Phase 1 probe (research.md decision 6) found `/login`/`/logout` usable over rpc-ui: sign
   a provider out, confirm the warning names the provider and mentions running sessions, confirm,
   and confirm the section updates; sign a provider back in and confirm OMP's own flow runs.
3. If the probe found it unusable: confirm the section is read-only and shows the "run `/login`/
   `/logout` in a terminal" instruction instead of a non-functional button.

**Story 4: the profile menu (FR-018 to FR-024)**

1. Open the profile menu. Expect: items appear in exactly this order: the account header, Manage
   accounts, Manage sessions, Theme, Keyboard shortcuts, the update entry, Health check, What's
   new, then Sign out, visually set apart.
2. Open the Theme submenu. Expect: every built-in dark preset, with the active one checked (icon and
   text); "Appearance settings" opens Settings' Appearance section (spec 007 — until that spec
   lands, it opens Settings with nothing further to show there yet).
3. Open Keyboard shortcuts. Expect: a read-only list matching docs/DESIGN.md's Keyboard table.
4. Look at the update entry. Expect: "Check for updates" with no update pending; once spec 006
   lands its update state, "Restart to update <version>" while one is downloaded and waiting.
5. Select Health check. Expect: the first-run readiness checks re-run and their result shows.
6. Select What's new. Expect: the installed version's release notes open in the system browser,
   never inside the app window.
7. Using only the keyboard: open the menu, arrow through every item and into and out of the Theme
   submenu, press Esc, and confirm focus returns to the profile item.

**Story 5: manage sessions (FR-025)**

1. With Sessions in more than one repository, including at least one archived, open Manage
   sessions from the profile menu. Expect: every Session listed with its repository, status, and
   archive state.
2. Archive an active one, then restore it. Expect: it moves to archived and back, matching its own
   repository's session list (spec 001).
3. Delete a Session from this screen. Expect: the same confirmation spec 001 FR-029 requires,
   naming its uncommitted changes and unpushed commits.

**Memory badge (FR-029 — implemented by spec 001's existing task T099, not a task of this spec)**

- Once spec 001's T099 lands, confirm the low-memory badge appears on the profile item instead of
  a status bar, with the same Stop agent popover spec 001's own quickstart already checks.

## First-task gates

These facts are unverified and are checked before the work that depends on them (tasks.md
Phase 1, T001-T002):

- The exact `gh auth status --json hosts` shape with two or more accounts on one host, and the
  exact `gh auth login --web` one-time-code stdout text.
- Whether OMP's own `/login`/`/logout` can be driven, and its provider state read, over Refract's
  existing rpc-ui connection.
