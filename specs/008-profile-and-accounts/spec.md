# Feature Specification: Profile and accounts

**Feature Branch**: `008-profile-and-accounts` (no branch created; work lands on `main`)
**Created**: 2026-10-02
**Status**: Draft
**Input**: Stuart's request: "#13 In bottom left or top left show a profile item, with settings
cog icon. Settings icon opens settings pages. Profile opens menu with theme switcher, profile
switcher (See item 14), keyboard shortcuts display. Could be a place to put update process. #14
Logout and Login process, manage accounts (Github OAuth?). Use Github profile info from their
API?" Reference screenshots: `Screenshot 2026-10-01 103039.png` (a bottom-left bar: round avatar
photo, the user's name, a feedback icon, and a cog) and `Screenshot 2026-10-02 150514.png` (the
GitHub Copilot desktop app's profile menu: a header with an avatar, the `@handle`, and a usage
line; Manage accounts; Manage sessions; a Theme submenu with a check on System, Light, Dark, and
"Make it yours"; Keyboard shortcuts with a `?` hint; "Restart to update" with a version badge;
Health check; What's new; About; Help center; and Sign out in red).

## Clarifications

### Session 2026-10-02

- Q: How does the developer sign in to GitHub? -> A: The GitHub CLI does the sign-in. Refract
  drives the GitHub CLI's own sign-in, sign-out, switch, and status; this is for now, and a
  spike on a Refract-owned GitHub OAuth flow is a separate later task.
- Q: What does "manage accounts" cover? -> A: GitHub accounts and OMP's own provider sign-in.
- Q: Where does the avatar image come from? -> A: Fetch it in the main process, show the face.
  The main process fetches the GitHub avatar, checks it is a small PNG or JPEG, caches it, and
  gives the window a local image; the window itself never loads a remote URL.
- Q: Which extra items belong in the profile menu? -> A: Health check, What's new, and Manage
  sessions; not About, not Help center.

### Session 2026-10-16

- Q: Does the update entry's "otherwise" wording (FR-021) need its own busy state, given a
  check/download/install can take a visible moment? -> A: Yes -- gate round 2 (issue #569):
  "Check for updates" is reserved for the ready-to-act state; while one of those three is
  actually running the entry instead shows its own verb ("Checking for updates…"/"Downloading
  update…"/"Installing update…"), `aria-disabled`, matching the busy-state pattern the same
  menu's "GitHub unavailable, Checking…" row already uses.

### Session 2026-10-20

- Q: The Theme submenu's round swatches read as radio buttons that are all unselected -- how
  does the checked state actually show? -> A: #1043 -- the Theme list becomes a real radio
  group (`menuitemradio`, `aria-checked`), drawn with the same leading ring-and-dot radio
  indicator the Ask card's radios use (ring, filled dot when selected), never a round swatch
  mistaken for a radio.
- Q: Where does the colour swatch go instead? -> A: After the name, as a small square chip
  (`size-3 rounded-[2px]`, bordered, decorative) -- never round, so it cannot read as a second
  radio; the trailing "✓ Current" text is dropped, since the checked radio's filled dot plus the
  screen reader's own "checked" state already carry that.
- Q: Is this a Theme-submenu-only fix or does it touch the shared component? -> A: The shared
  `DropdownMenuRadioItem` itself (ADR 0003): its trailing check becomes the leading radio mark,
  so every single-choice dropdown menu shows radios the same way. The Theme submenu is the first
  caller; the composer's Reasoning picker (the only other caller) picks up the new mark
  automatically.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See who you are and reach Settings (Priority: P1)

A profile item pinned at the bottom of the left nav shows the active GitHub account's avatar
(round), display name, and a cog button. Selecting the cog opens the Settings screen (spec 004).
Selecting the rest of the item opens the profile menu. When no GitHub account is signed in, the
item shows a generic avatar with "Sign in" instead of a name, and the menu offers a Sign in
action in its place.

**Why this priority**: Every other story in this spec hangs off this one item existing: the cog
is how Settings stays reachable once spec 004's left-nav Settings entry is retired, and the item
is what opens the menu every later story adds to.

**Independent Test**: With a GitHub account signed in, confirm the profile item shows that
account's avatar and display name and that the cog opens Settings; sign out, confirm the item
falls back to a generic avatar and "Sign in"; using only the keyboard, confirm the item and the
cog both take focus with a visible indicator and an accessible name.

**Acceptance Scenarios**:

1. **Given** a GitHub account is signed in, **When** the developer looks at the bottom of the
   left nav, **Then** the profile item shows that account's round avatar, its display name, and
   a separate cog button.
2. **Given** the profile item, **When** the developer selects the cog, **Then** the Settings
   screen (spec 004) opens; selecting anywhere else on the item opens the profile menu instead.
3. **Given** no GitHub account is signed in, **When** the developer looks at the profile item,
   **Then** it shows a generic avatar and the text "Sign in" in place of a name, and opening the
   menu offers a Sign in action.
4. **Given** the profile item and its cog, **When** the developer uses only the keyboard, **Then**
   both take focus with a visible indicator, in tab order, and both have an accessible name a
   screen reader can read as one phrase (for example "Stuart Hopwood, signed in to GitHub as
   stuarthopwood").
5. **Given** an active GitHub account, **When** the profile item is first shown or the active
   account changes, **Then** its avatar, display name, and handle come from that account's GitHub
   profile, fetched by the main process; the window itself never loads a remote image.
6. **Given** the active account's avatar is still loading, fails to load, or has none set, **When**
   the profile item is shown, **Then** it shows the account's initials instead of a broken image
   or a blank circle.

---

### User Story 2 - Sign in, switch, and sign out of GitHub accounts (Priority: P1)

Manage accounts lists every GitHub account known to the GitHub CLI, with the active one marked.
The developer can add an account, switch which one is active, and sign one out. The active
account is what drives the name and avatar on the profile item, and the access used by pull
request management (spec 003) and update checks (spec 006).

**Why this priority**: A profile item that can only ever show one fixed account is not account
management. Signing in, switching, and signing out are what make "accounts", plural, true, and
they rank with User Story 1 because the item is of limited use with nobody signed in.

**Independent Test**: With the GitHub CLI signed in to one account, open Manage accounts, add a
second account through its sign-in flow, switch the active account between the two, confirm the
profile item and a pull request view (spec 003) both pick up the switch, then sign one account
out and confirm the other becomes active.

**Acceptance Scenarios**:

1. **Given** the GitHub CLI is signed in to one or more accounts, **When** the developer opens
   Manage accounts, **Then** it lists every account the GitHub CLI knows about, with the active
   one marked by text as well as by colour.
2. **Given** Manage accounts is open, **When** the developer chooses to add an account, **Then**
   the system browser opens through the GitHub CLI's own sign-in flow, and Manage accounts shows
   the flow's one-time code and its progress until it completes or is cancelled.
3. **Given** two or more signed-in accounts, **When** the developer chooses a different one as
   active, **Then** it becomes active immediately, and the profile item's name and avatar update
   to match.
4. **Given** the active account changes, **When** a pull request view (spec 003) or an update
   check (spec 006) next runs, **Then** it uses the newly active account; a request already under
   way when the switch happens finishes with the account it started with.
5. **Given** two or more signed-in accounts, **When** the developer signs one out, **Then** Manage
   accounts asks for confirmation naming that account, and, if it was the active one, naming which
   account becomes active next; confirming signs it out and, if it was active, makes the named
   account active.
6. **Given** exactly one signed-in account, **When** the developer signs it out, **Then** the
   confirmation says no account will remain active, and confirming leaves the profile item and
   menu in the signed-out state from User Story 1.
7. **Given** the GitHub CLI is not installed or not signed in to any account, **When** the
   developer looks at the profile item or opens Manage accounts, **Then** both say so, and offer
   the Install action from the first-run readiness screen (spec 006) when the GitHub CLI is
   missing, or a Sign in action when it is installed but signed out.
8. **Given** the machine is offline, **When** the developer looks at the profile item, **Then** it
   shows the last cached name and avatar for the active account rather than an error or a blank
   state.

The profile menu's own Sign out item signs out the active account under this same confirmation
rule. Refract never stores a GitHub access token: every sign-in, switch, and sign-out above goes
through the developer's own GitHub CLI, the same stance as spec 003 FR-027 and spec 006.

---

### User Story 3 - Manage OMP sign-in beside GitHub (Priority: P2)

Manage accounts also shows OMP's own provider sign-in state: which providers OMP is signed in to,
matching the check the first-run readiness screen already makes. The developer can sign in or out
of a provider through OMP's own flow, in a section kept separate from and labelled apart from the
GitHub accounts section.

**Why this priority**: It extends Manage accounts to the other account Refract depends on, but it
is a smaller, narrower addition than User Story 2's GitHub flows, and nothing else in this spec
depends on it.

**Independent Test**: With OMP signed in to a provider, open Manage accounts, confirm its OMP
section shows that provider as signed in separately from the GitHub section, sign it out, confirm
the warning names the provider and mentions running sessions, and confirm the section reflects
the new state.

**Acceptance Scenarios**:

1. **Given** OMP is signed in to one or more providers, **When** the developer opens Manage
   accounts, **Then** a separate, labelled OMP section lists each provider's sign-in state,
   distinct from the GitHub accounts section.
2. **Given** the OMP section, **When** the developer signs in to a provider, **Then** OMP's own
   sign-in flow runs and the section updates to reflect the new state once it completes.
3. **Given** a provider OMP is signed in to, **When** the developer signs it out, **Then** the
   confirmation names that provider and warns that sessions currently running use it, and
   confirming signs it out.
4. **Given** the GitHub and OMP sections, **When** the developer reads either one, **Then** each
   is clearly labelled as to which account system it covers, and neither influences the other's
   listed state.

Whether OMP's own sign-in flow can be driven, and its provider state read, over Refract's existing
connection to OMP is unverified; this must be probed and recorded in `docs/spike/FINDINGS.md`
before a plan relies on it, per constitution Principle IV.

---

### User Story 4 - The profile menu (Priority: P2)

Selecting the profile item (anywhere except the cog) opens a menu, in this fixed order: the
account header (avatar and `@handle`), Manage accounts, Manage sessions, a Theme submenu, Keyboard
shortcuts, the update entry, Health check, What's new, and, last and set apart, Sign out.

**Why this priority**: The menu is what turns the profile item into the place Stuart asked for —
theme switching, account management, shortcuts, and the update process. It ranks behind Stories 1
and 2 because the item and GitHub accounts have to exist first for the menu to show anything
meaningful.

**Independent Test**: Open the profile menu and confirm every item listed above appears in that
order; open the Theme submenu and confirm the active theme is checked; open Keyboard shortcuts and
confirm a list appears; open and close the menu, and move through it, using only the keyboard.

**Acceptance Scenarios**:

1. **Given** the developer selects the profile item, **When** the menu opens, **Then** its items
   appear in this order: the account header, Manage accounts, Manage sessions, Theme, Keyboard
   shortcuts, the update entry, Health check, What's new, and Sign out, with Sign out visually set
   apart from the rest.
2. **Given** the menu is open, **When** the developer points at or selects Theme, **Then** a
   submenu opens as a real radio group (`menuitemradio`/`aria-checked`) listing every built-in
   dark preset, the currently active one marked by a filled leading ring-and-dot indicator (the
   Ask card's own radio mark), each preset's colour swatch shown as a small square chip after its
   name, and an "Appearance settings" entry that opens the Settings screen's Appearance section
   (spec 007).
3. **Given** the menu is open, **When** the developer selects Keyboard shortcuts, **Then** a
   read-only list of shortcuts opens; its entries come from the shortcut set tracked as backlog
   issue #6 once that work exists, and until then the list shows the shortcuts that exist today
   (for example Enter, Shift+Enter, Esc, Ctrl+Shift+X, and F2).
4. **Given** a downloaded update is waiting to install, **When** the developer looks at the update
   entry, **Then** it reads "Restart to update" with the new version's number; **Given** no update
   is waiting, **When** the developer looks at it, **Then** it reads "Check for updates", and
   selecting it checks again (spec 006).
5. **Given** the menu is open, **When** the developer selects Health check, **Then** Refract
   re-runs the first-run readiness checks (spec 006) and shows the result.
6. **Given** the menu is open, **When** the developer selects What's new, **Then** the installed
   version's release notes open in the system browser.
7. **Given** the menu is open, **When** the developer uses only the keyboard, **Then** arrow keys
   move through its items and into and out of the Theme submenu, Esc closes the menu, and focus
   returns to the profile item once it closes.

---

### User Story 5 - Manage sessions (Priority: P3)

Selecting Manage sessions from the profile menu opens a Sessions management screen listing every
session across every repository, with its repository, status, and archive state, offering the
archive, restore, and delete actions spec 001 already defines, with the same confirmations.

**Why this priority**: It is a convenience view over sessions that already exist and are already
manageable from each repository's own session list (spec 001); it adds a cross-repository view
rather than new capability, so it ranks last.

**Independent Test**: With sessions in more than one repository, including at least one archived
session, open Manage sessions from the profile menu, confirm every session is listed with its
repository, status, and archive state, archive an active one, restore the archived one, and delete
a session, confirming each action's confirmation names what will be lost.

**Acceptance Scenarios**:

1. **Given** sessions exist across more than one repository, **When** the developer selects Manage
   sessions from the profile menu, **Then** every session is listed with its repository, its
   status (working, idle, needs you, or stopped), and whether it is active or archived.
2. **Given** an active session in the list, **When** the developer archives it, **Then** it shows
   as archived in this same list, following spec 001's archive behaviour.
3. **Given** an archived session in the list, **When** the developer restores it, **Then** it shows
   as active again, and reappears in its repository's own session list.
4. **Given** a session in the list, **When** the developer deletes it, **Then** Refract asks for
   confirmation naming its uncommitted changes and unpushed commits before deleting it, exactly as
   spec 001 FR-029 requires.

## Edge Cases

- Several GitHub accounts share the same display name: each is still distinguishable by its
  handle, which Manage accounts and any name-bearing control show alongside the name.
- The active account is switched while a pull request view or an update check is already running:
  the request in flight finishes with the account it started with; the next request uses the newly
  active account.
- The GitHub profile fetch fails, is slow, or is rate limited: the profile item and menu show the
  last cached name and avatar without an error toast.
- An avatar response is not a small PNG or JPEG, is too large, or points off GitHub's avatar host:
  it is rejected and initials are shown instead.
- The active account's display name is empty: its handle is shown in its place everywhere the
  name would appear.
- Signing out the active account when others remain: the confirmation names which account becomes
  active next, and that account becomes active once signed out.
- Signing out the last remaining account: the profile item and menu return to the signed-out state
  from User Story 1.
- Signing an OMP provider out while a session is mid-turn: the confirmation warns that running
  sessions use that provider before the developer confirms.
- Health check is run while an agent is starting: it reports the state it finds without
  interrupting the agent that is starting.
- The developer switches themes from the menu while Settings is open with a previewed theme
  already pending: spec 007's Cancel rules govern the previewed theme, unaffected by the switch
  happening from the menu instead of from Settings.
- The left nav is collapsed or narrow: the profile item shows only the avatar and the cog; the
  name is hidden from view but still present as the item's accessible name and as a tooltip.
- The left nav is hidden entirely: Settings and the profile menu stay reachable another way (see
  Assumptions).
- A very long display name: it truncates with an ellipsis rather than wrapping or overflowing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A profile item MUST be pinned at the bottom of the left nav, showing the active
  GitHub account's round avatar and display name alongside a separate cog button.
- **FR-002**: Selecting the cog MUST open the Settings screen (spec 004); this replaces spec 004
  FR-011's left-nav "Settings" entry as the way Settings is reached.
- **FR-003**: Selecting the profile item anywhere other than the cog MUST open the profile menu.
- **FR-004**: When no GitHub account is signed in, the profile item MUST show a generic avatar and
  the text "Sign in" in place of a name, and the profile menu MUST offer a Sign in action in place
  of the account header and Sign out.
- **FR-005**: The profile item and its cog MUST both be reachable by keyboard, in tab order, each
  with a visible focus indicator and an accessible name a screen reader can read as one phrase
  (name and GitHub sign-in state together).
- **FR-006**: The active GitHub account's avatar, display name, and handle MUST be fetched by the
  main process from that account's GitHub profile; the renderer window MUST NOT load a remote
  image or make the GitHub profile request itself (constitution Principle V).
- **FR-007**: A fetched avatar MUST be checked as a small PNG or JPEG from GitHub's avatar host
  before use and cached; a response that fails that check or is too large MUST be rejected. Every
  surface showing an account's avatar MUST show its initials instead while the avatar is loading,
  has failed, or is unset.
- **FR-008**: Manage accounts MUST list every GitHub account the GitHub CLI knows about, marking
  the active one by text as well as by colour.
- **FR-009**: Manage accounts MUST offer adding a GitHub account, which opens the system browser
  through the GitHub CLI's own sign-in flow and shows that flow's one-time code and progress until
  it completes or is cancelled.
- **FR-010**: Manage accounts MUST let the developer switch which signed-in GitHub account is
  active, taking effect immediately for the profile item and for the next pull request or update
  request.
- **FR-011**: Signing out a GitHub account, from Manage accounts or from the profile menu's Sign
  out, MUST require a confirmation naming that account; when it is the active account and others
  remain, the confirmation MUST name which account becomes active next.
- **FR-012**: Refract MUST NOT store a GitHub access token for this feature; every GitHub sign-in,
  switch, sign-out, and status read MUST go through the developer's own GitHub CLI, the same
  stance as spec 003 FR-027 and spec 006.
- **FR-013**: The active GitHub account MUST be the one pull request management (spec 003) and
  update checks (spec 006) use; a request already in progress when the active account changes
  MUST finish with the account it started with.
- **FR-014**: When the GitHub CLI is not installed, the profile item and Manage accounts MUST say
  so and offer the Install action from the first-run readiness screen (spec 006); when it is
  installed but signed out, both MUST offer a Sign in action instead.
- **FR-015**: While offline, the profile item MUST show the active account's last cached name and
  avatar rather than an error or a blank state.
- **FR-016**: Manage accounts MUST include a separate, labelled section showing OMP's own
  provider sign-in state (which providers OMP is signed in to), distinct from the GitHub accounts
  section.
- **FR-017**: The OMP section MUST let the developer sign in to or out of a provider through OMP's
  own sign-in flow; signing out MUST require a confirmation naming the provider and warning that
  sessions currently running use it.
- **FR-018**: The profile menu MUST list its items in this fixed order: the account header,
  Manage accounts, Manage sessions, Theme, Keyboard shortcuts, the update entry, Health check,
  What's new, and Sign out, with Sign out visually set apart from the rest.
- **FR-019**: The Theme item MUST open a submenu listing every built-in dark preset as a real
  radio group (`menuitemradio`, `aria-checked`), the currently active one marked by a leading
  ring-and-dot radio indicator (FR-030), each preset's colour swatch shown as a small square chip
  after its name (never round, so it is never mistaken for a radio), plus an "Appearance
  settings" entry that opens the Settings screen's Appearance section (spec 007).
- **FR-020**: The Keyboard shortcuts item MUST open a read-only list of Refract's current keyboard
  shortcuts; its entries MUST come from the shortcut set defined by backlog issue #6 once that
  work exists, and MUST otherwise list the shortcuts already present in the app.
- **FR-021**: The update entry MUST read "Restart to update" with the new version's number when an
  update has downloaded and is waiting for the next quit, "Check for updates" when idle,
  available, failed, or GitHub-CLI-unavailable (selecting it in these states MUST check again,
  spec 006), and its own busy verb -- "Checking for updates…", "Downloading update…", or
  "Installing update…" -- while a check, download, or install is already running (amended
  2026-10-16, issue #569 decision 5: the busy sub-states were not distinguished in the original
  wording).
- **FR-022**: The Health check item MUST re-run the first-run readiness checks (spec 006) and show
  their result.
- **FR-023**: The What's new item MUST open the installed version's release notes in the system
  browser.
- **FR-024**: The profile menu MUST open and close with the keyboard: arrow keys MUST move focus
  through its items and into and out of the Theme submenu, Esc MUST close the menu, and focus
  MUST return to the profile item once the menu closes.
- **FR-025**: Manage sessions MUST open a screen listing every session across every repository,
  each with its repository, status, and archive state, offering the archive, restore, and delete
  actions spec 001 defines, with the delete confirmation spec 001 FR-029 requires.
- **FR-026**: When the left nav is collapsed or narrow, the profile item MUST show only the avatar
  and the cog; the display name MUST stay available as the item's accessible name and as a
  tooltip.
- **FR-027**: Every control introduced by this spec (the profile item, the cog, every menu item,
  every Manage accounts and Manage sessions action) MUST have an accessible name, and every state
  that distinguishes one thing from another (the active account marker, the active theme's check,
  a sign-in or sign-out state) MUST be conveyed by an icon or text, never by colour alone.
- **FR-028**: A display name too long to fit its container MUST truncate with an ellipsis rather
  than wrap or overflow.
- **FR-029**: The low-memory and unverified-OMP-version alert rows under the profile item are specified in full by spec 001 FR-037 and FR-072; this spec only fixes their position, directly beneath the profile item, replacing the status bar's old low-memory notice (spec 001 FR-056).
- **FR-030**: The shared `DropdownMenuRadioItem` component (ADR 0003 -- every single-choice
  dropdown menu draws its checked state the same way, never a second hand-rolled mark) MUST draw
  a leading ring-and-dot radio indicator matching `radio-group.tsx`'s own `RadioGroupIndicator`
  (the Ask card's radio look: a ring, filled with a dot when checked), never a trailing check
  standing in for a radio. The Theme submenu (FR-019) and the composer's Reasoning picker are its
  two current callers.

### Key Entities

- **Profile item**: the bottom-of-left-nav control showing the active GitHub account's avatar and
  display name, with a separate cog button; shown in a signed-out state when no GitHub account is
  signed in.
- **Profile menu**: the menu the profile item opens, listing the account header, Manage accounts,
  Manage sessions, Theme, Keyboard shortcuts, the update entry, Health check, What's new, and Sign
  out, in that order.
- **GitHub account**: one account the GitHub CLI is signed in to, with a display name, a handle,
  and an avatar; exactly one is active at a time.
- **OMP provider sign-in**: one provider OMP is signed in to, shown and managed in Manage
  accounts' OMP section, separate from GitHub accounts.
- **Avatar cache**: the main process's small, validated, locally cached copy of an account's
  GitHub avatar image, from which the window is given a local image rather than a remote URL.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The profile item correctly reflects the active GitHub account's name and avatar, or
  the signed-out state, 100% of the time it is shown, across sign-in, switch, and sign-out.
- **SC-002**: Switching the active GitHub account updates the profile item within 1 second, and
  the next pull request or update request after the switch uses the newly active account 100% of
  the time, while a request already in flight always finishes with the account it started with.
- **SC-003**: Signing out an account always requires an explicit confirmation naming that account,
  100% of the time, whether reached from Manage accounts or the profile menu's Sign out.
- **SC-004**: No avatar is ever shown that is not a validated small PNG or JPEG fetched by the main
  process; the window never issues a request for a remote image.
- **SC-005**: The profile menu always opens in the fixed order defined by FR-018, and every item
  in it leads to the behaviour named for it (Settings' Appearance section, the shortcut list, the
  update flow, the readiness checks, the release notes, or the sign-out confirmation).
- **SC-006**: The profile item, the cog, the profile menu, its Theme submenu, and every Manage
  accounts and Manage sessions action are fully operable using only the keyboard, with a visible
  focus indicator throughout and focus returned to the profile item when the menu closes.
- **SC-007**: Manage sessions lists every session across every repository, with its repository,
  status, and archive state matching what each repository's own session list shows, 100% of the
  time.
- **SC-008**: No account marker, theme check, or sign-in state is ever conveyed by colour alone;
  each is also shown by an icon or text.

## Assumptions

- Placement is bottom-left of the left nav. Stuart's request allowed "bottom left or top left";
  this spec chooses bottom-left to match his reference screenshot, which shows the bar at the
  bottom.
- The feedback icon shown in the bottom-left reference screenshot, and the About and Help center
  entries shown in the reference menu screenshot, are not part of this spec: Stuart's menu-extras
  answer named Health check, What's new, and Manage sessions only.
- The usage line shown under the `@handle` in the reference menu screenshot is not part of this
  spec, for the same reason.
- GitHub sign-in is done through the GitHub CLI for now. A spike into a Refract-owned GitHub OAuth
  flow is a separate, later task; its outcome may change how accounts are signed in, but that is
  an open question for that later task, not a requirement of this spec.
- The avatar fetch in FR-006 and FR-007 is the one case in Refract where the main process itself
  downloads an image from the network; it is bounded to GitHub's avatar host, checked for size and
  type, and never handed to the window as a remote URL, consistent with constitution Principle V.
- Whether OMP's own sign-in flow can be driven, and its provider state read, over Refract's
  existing connection to OMP (User Story 3) is unverified. It must be probed and the result
  recorded in `docs/spike/FINDINGS.md` before a plan relies on it, per constitution Principle IV.
- When the left nav itself is hidden, Settings and the profile menu need another way to stay
  reachable, for example a keyboard shortcut or a title-bar control; which one is an open question
  to confirm with Stuart, not decided by this spec.
- This spec depends on: spec 003 (the GitHub access the active account drives), spec 004 (the
  Settings screen the cog opens; its FR-011 left-nav "Settings" entry is replaced by this spec's
  cog), spec 006 (the update entry's state, and the GitHub CLI Install action offered when it is
  missing), spec 007 (the Theme submenu and its "Appearance settings" link to Settings'
  Appearance section), and backlog issue #6 (the keyboard shortcut set Keyboard shortcuts will
  eventually list in full).
- Windows 11 is the only supported platform, consistent with the constitution.
- No telemetry is added by this spec.
