# Quickstart: verifying profile and accounts

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/](contracts/).

## Prerequisites

- Windows 11, `omp` 18.4.x or 18.5.x on `PATH` and signed in (same as specs/001's quickstart).
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

> A second GitHub account is not required to run this story: a scratch `GH_CONFIG_DIR` (a
> throwaway config directory with `hosts.yml` entries holding fake accounts and `GH_BROWSER` set
> to a no-op) exercises switch, sign-out, and the real device-code flow without a second real
> account or touching your real login.

1. Open Manage accounts. Expect: every GitHub CLI account is listed under "GitHub accounts", the
   active one marked by both the word "Active" and the left accent border (never colour alone).
2. Select **Add account**. Expect: the one-time code appears, grouped as `XXXX-XXXX`, with a
   **Copy code** button (copies the ungrouped code; does not auto-copy) and a link to open the
   GitHub device page directly; the system browser also opens through the GitHub CLI's own device
   flow, and the panel shows progress until you complete it in the browser or select **Cancel**
   (shows "Cancelling…" for about 2 seconds, then returns).
3. With two accounts signed in, select **Switch** on the inactive row. Expect: that row shows a
   spinning "Switching…" state, then becomes active -- the profile item's name and avatar update
   within 1 second (SC-002) and the active marker never moves before `gh` itself confirms.
4. Select **Sign out** on the active row while two remain. Expect: a confirmation reading "Sign
   out @<login> on <host>? @<next-login> will become the active account."; confirming signs it
   out and makes the named account active.
5. Sign out the one remaining account. Expect: the confirmation reads "Sign out @<login> on
   <host>? No account will remain active."; confirming shows "No GitHub account is signed in" in
   Manage accounts and returns the profile item and menu to the signed-out state (Story 1).
6. Run `gh auth logout` for every account outside Refract, or uninstall the GitHub CLI from PATH,
   then look at the profile item and Manage accounts. Expect: both say so, offering Sign in (CLI
   present) or the Install action from the readiness screen (CLI missing, spec 006).

**Story 3: manage OMP sign-in beside GitHub (FR-016, FR-017)**

> `/login`/`/logout` were confirmed NOT drivable over OMP's rpc-ui connection (research.md
> Decision 6, FINDINGS item 43): this section is read-only, and these steps cannot exercise a real
> sign-in (it needs a person at a terminal and a provider account to sign in to) or a real
> OMP-missing failure -- only what is below.

1. Open Manage accounts. Expect: below a separator under the GitHub section, an "OMP provider
   sign-in" section, labelled apart from GitHub. On first open it shows a skeleton (three rows,
   "Checking OMP providers…") while a scratch `omp` process reads the list (several seconds);
   focus stays on the GitHub section's Add account button throughout.
2. Once loaded. Expect: a summary line ("N of M providers signed in", or "All M providers signed
   in"), every signed-in provider listed by its raw id with a check icon and "Signed in", and (if
   any remain) a collapsed "Show all M providers…" disclosure.
3. Open the disclosure. Expect: it reads "Show signed in only", focus stays on it, and the rest of
   OMP's providers list below it, each with a minus icon and "Not signed in".
4. Select **Check again**. Expect: a "Checking…" indicator appears beside it while the still-
   visible list stays exactly as it was (no loading flash), then a fresh summary.
5. Select **Copy command**. Expect: its label becomes "Copied" for about 2 seconds, and `omp
   login` is on the clipboard.
6. Confirm there is no Sign in or Sign out control anywhere in this section, only the "run `omp
   login` in a terminal" instruction -- and that it never mentions `/logout`.

**Story 4: the profile menu (FR-018 to FR-024)**

> Two items described by the spec are NOT in this menu yet, by design, not oversight: **Manage
> sessions** lands with the screen it opens (Phase 7); the update entry lands once spec 006 ships
> `updates.get()`/`updates:changed` (neither exists yet). Both have a reserved, commented slot in
> the code at the position they will appear.

1. Open the profile menu. Expect: items appear in this order: the account header, Manage
   accounts, Theme, Keyboard shortcuts, Health check, What's new, then Sign out, visually set
   apart by separators.
2. Open the Theme submenu. Expect: every built-in dark preset with its real swatch colour, the
   active one marked by a check icon and the word "Current". Choose a different preset. Expect:
   it applies and persists immediately (no Save/Cancel step, unlike Settings' Appearance
   section), the menu closes, focus returns to the profile item, and a screen reader announces
   "Applied theme <name>". Reopen the menu and the Theme submenu: the newly chosen preset is now
   the one checked. "Appearance settings…" opens Settings' Appearance section.
3. Open Keyboard shortcuts. Expect: a read-only list grouped under "Message box" and "Split
   view", showing only Send/Newline/Clear/Stop and Open in split/Move focus between panes --
   fewer rows than docs/DESIGN.md's own "Keyboard" table, which documents several chords with no
   working handler yet (tracked as a GitHub issue). Focus starts on Done; Esc or Done closes it
   and returns focus to the profile item.
4. Select Health check. Expect: a dialog opens and immediately re-runs the first-run readiness
   checks, each row briefly reading "Checking <name>" with a spinner, then the real result (icon
   plus the visible word Passed/Passed with a warning/Failed, never colour alone) with its own
   found/hint text if any. Select Check again: expect the same loading-then-result cycle, with
   focus kept on Check again throughout and Done staying enabled while it runs.
5. Select What's new. Expect: the installed version's release notes open in the system browser,
   never inside the app window, with a toast confirming it.
6. Using only the keyboard: open the menu, arrow through every item and into and out of the
   Theme submenu, press Esc, and confirm focus returns to the profile item.

**Story 5: manage sessions (FR-025, FR-027)**

1. With Sessions in more than one repository, including at least one archived, open "Manage
   sessions" from the profile menu (present in every sign-in state). Expect: a header reading
   "Manage sessions" with a count ("{n} sessions across {m} repositories"), a Back to chat
   button, and a toolbar (search, repository filter, archive filter, sort).
2. Confirm every Session is listed with its status (an icon plus the visible status word,
   e.g. "Working"), repository and branch, and last activity; an archived Session additionally
   shows an "Archived" badge, and one whose worktree is missing shows "Worktree missing".
3. Search by name or branch, filter by repository, and switch the archive filter between
   All/Active/Archived. Expect: the list and the "Showing X of N sessions" count update,
   announced politely; pressing Esc in the search field with text in it clears it and restores
   the full list.
4. Sort by each option (Recently active, Name, A to Z, Repository, A to Z, Status). Expect: the
   row order changes to match.
5. Open a row's "..." menu. Expect: the same action list the session list's own row menu offers
   (rename, open in split, copy worktree path, open worktree folder, archive/restore, stop
   agent, delete).
6. Click a row's name/info area to open it. Expect: it opens in the chat view and this screen
   returns to the chat view; Ctrl+click opens it in a split instead.
7. Archive an active Session using its quick-action button while filtered to Active. Expect: it
   drops out of the filtered list, the removal is announced, and focus lands on the next row's
   open button, else the previous row's, else the search input -- never lost to the page.
8. Restore the archived Session. Expect: it moves back into the active list (or disappears if
   filtered to Archived) and the change is announced, matching its own repository's session
   list (spec 001).
9. Delete a Session from this screen. Expect: the same confirmation spec 001 FR-029 requires,
   naming its uncommitted changes and unpushed commits, and the removal is announced the same
   way as archive/restore.
10. Search for text that matches no Session. Expect: a "No matching sessions" message and a
    "Clear filters" button that resets search, repository, and archive filters together.
11. With no Sessions in any repository, open Manage sessions. Expect: "No sessions yet" with a
    short instruction and a Back to chat button.

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
