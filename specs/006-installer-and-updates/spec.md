# Feature Specification: Installer and updates

**Feature Branch**: `006-installer-and-updates` (no branch created; work lands on `main`)
**Created**: 2026-10-02
**Status**: Draft
**Input**: Stuart's request: "Feature: Installable package, install's all dependencies
including OMP and Git if needed, creates an desktop icon to launch Refract. Update checker and
update process, uninstaller."

## Clarifications

### Session 2026-10-02

- Q: Does the installer itself install Refract's dependencies (Git, OMP), or does something
  else install them? -> A: The installer installs only Refract. Refract's first-run readiness
  screen gets an Install action next to each missing item, Git and OMP.
- Q: Where do updates come from? -> A: Private GitHub Releases, read through the developer's own
  signed-in GitHub CLI; no token is stored, the same stance as spec 003 FR-027.
- Q: What does the update flow look like once a newer version is found? -> A: Notify, you click,
  installs on quit. Refract checks at startup and on a Check for updates button; a badge
  announces a new version; the developer clicks Update; it downloads and installs when Refract
  is next quit; it never interrupts a running agent.

### Session 2026-10-22 (issue #883)

- Q: How frictionless should updates be? -> A: Re-check every 4 hours while open, download a
  found update in the background, then prompt with "Update now" in the sidebar notice stack
  (restart and install at once, confirming first if agents are running). Ignoring the prompt
  keeps install-on-quit. FR-032 to FR-035 supersede the "you click, installs on quit" answer
  above and the click in FR-014.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install Refract (Priority: P1)

A developer downloads one installer file and runs it. Refract installs for the current Windows
user without administrator rights, adds a Desktop shortcut and a Start menu entry using the
Refract icon, appears in Windows Settings > Apps with its installed version, and can be launched
from either shortcut. A first launch shows the first-run readiness screen. Installing over an
existing install upgrades it in place and keeps the developer's repositories, Sessions, and
settings.

**Why this priority**: Without an install path, nobody besides the current `pnpm dev` workflow
can run Refract. This is the feature's foundation; every other story in this spec assumes an
installed app already exists.

**Independent Test**: On a clean Windows 11 profile with no Refract installed, run the
downloaded installer file, confirm it completes without an administrator prompt, confirm both
shortcuts open Refract, confirm it is listed in Windows Settings > Apps with its version, then
run the same installer file again and confirm it upgrades in place.

**Acceptance Scenarios**:

1. **Given** a Windows 11 machine with no Refract installed, **When** the developer runs the
   downloaded installer file, **Then** it completes without requesting administrator rights, and
   Refract is installed for the current Windows user only.
2. **Given** a completed install, **When** the developer looks at the desktop and the Start
   menu, **Then** a Desktop shortcut and a Start menu entry both exist, both showing the Refract
   icon.
3. **Given** a completed install, **When** the developer opens Windows Settings > Apps, **Then**
   Refract is listed there with its installed version.
4. **Given** a completed install, **When** the developer launches Refract from either shortcut,
   **Then** Refract opens.
5. **Given** a first launch after install, **When** Refract opens, **Then** it shows the
   first-run readiness screen covered by User Story 2.
6. **Given** an existing install with repositories, Sessions, and settings recorded, **When** the
   developer runs a newer installer file, **Then** Refract upgrades in place, and the developer's
   repositories, Sessions, and settings all survive the upgrade.

---

### User Story 2 - Get missing dependencies from the first-run screen (Priority: P1)

On the first-run readiness screen, each missing or unsupported item offers an Install action:
Git (installed as Git for Windows), OMP (a supported 18.4.x or 18.5.x version only, since
Refract supports only those OMP minor lines), and the GitHub CLI, shown as an optional item
needed for updates (User Story 3)
and for pull request access (spec 003). Installing runs the product's own official installer,
shows progress and the outcome, then re-checks the checklist automatically. The OMP sign-in step
stays manual with its existing hint, because Refract cannot sign in for the developer. A failed
or cancelled install shows an actionable reason and leaves the checklist usable. Refract itself
never asks for administrator rights, though a product's own installer may make Windows ask.

**Why this priority**: Install alone (User Story 1) gets Refract onto the machine, but Refract
cannot do anything useful until Git and OMP are present and OMP is signed in. This is what turns
"installed" into "usable" without the developer ever leaving the app.

**Independent Test**: On a machine with Refract installed and neither Git nor OMP present, open
Refract, use the readiness screen's Install action next to Git, confirm it shows progress and an
outcome and the checklist re-checks automatically; repeat for OMP; confirm the GitHub CLI item
is marked optional; confirm the OMP sign-in step still asks the developer to sign in manually.

**Acceptance Scenarios**:

1. **Given** the first-run readiness screen shows Git as missing, **When** the developer selects
   its Install action, **Then** Refract runs Git for Windows's own official installer, shows
   progress and the outcome, and re-checks the checklist automatically once it finishes.
2. **Given** the first-run readiness screen shows OMP as missing, **When** the developer selects
   its Install action, **Then** Refract installs a supported 18.4.x or 18.5.x version of OMP, shows
   progress and the outcome, and re-checks the checklist automatically.
3. **Given** OMP is installed but on an unsupported version, **When** the developer looks at the
   checklist, **Then** it reports OMP as unsupported with an explanation, rather than treating it
   as passing or silently installing a different version over it.
4. **Given** the checklist, **When** the developer looks at the GitHub CLI item, **Then** it is
   marked optional, and the checklist can pass without it.
5. **Given** OMP is installed and on a supported version but not signed in, **When** the
   developer looks at the checklist, **Then** the sign-in step still shows its existing manual
   hint, because Refract cannot sign in to OMP on the developer's behalf.
6. **Given** the developer selects Install for a dependency, **When** that product's own
   installer is blocked, cancelled, or fails, **Then** the checklist shows an actionable reason
   and stays usable, with that item still offering Install.
7. **Given** any dependency install the developer runs from the checklist, **When** Refract
   requests it, **Then** Refract itself never asks for administrator rights, though the
   product's own installer may make Windows ask.
8. **Given** every checklist item passes, **When** the developer looks at the readiness screen,
   **Then** the existing Add repository action (spec 001) becomes enabled, unchanged from today.

---

### User Story 3 - Learn about and install updates (Priority: P2)

Refract checks for a newer release at startup and through a Check for updates button in Settings
(spec 004). A badge near the app title announces a new version, with its version number and a
link to its release notes. Clicking Update downloads it and installs it when Refract is next
quit normally, never interrupting a running agent or turn; the next launch runs the new version.
The download is verified against a published checksum before it is installed. When GitHub CLI
access is unavailable (not installed or not signed in) or the machine is offline, the check says
so in plain words without an error toast, and the app works as usual. A failed install leaves
the previous version working.

**Why this priority**: Updates matter once Refract is already installed and in daily use
(User Story 1), but the app is fully usable without them in the short term, and simply notifying
the developer is lower-risk than installing without being asked. It ranks behind getting Refract
onto the machine and ready to use.

**Independent Test**: With a newer private GitHub Release published and the developer's GitHub
CLI signed in, open Refract and confirm the startup check finds it (or press Check for updates
in Settings), confirm the badge, version, and release notes link appear, click Update, quit
Refract normally, and confirm it relaunches as the new version. Separately, with the GitHub CLI
signed out, confirm the check reports that in plain words and nothing else in the app changes.

**Acceptance Scenarios**:

1. **Given** a newer release is published, **When** Refract starts, **Then** it checks for an
   update and, on finding one, shows a badge near the app title.
2. **Given** the developer opens Settings, **When** they select Check for updates, **Then**
   Refract checks again immediately, independent of the startup check.
3. **Given** an available update, **When** the developer looks at the badge, **Then** it leads to
   the new version's number and a link to its release notes, which opens in the system browser.
4. **Given** an available update, **When** the developer clicks Update, **Then** Refract
   downloads it, verifies it against the release's published checksum, and holds it ready to
   install.
5. **Given** a downloaded, verified update is waiting, **When** the developer quits Refract
   normally, **Then** it installs before the next launch, and the next launch runs the new
   version.
6. **Given** a turn is running in any Session, **When** an update is waiting to install, **Then**
   Refract does not quit or install on its own; it waits for the developer's own normal quit.
7. **Given** the developer has not signed in to the GitHub CLI, or the machine is offline,
   **When** Refract checks for an update, **Then** it says so in plain words, without an error
   toast, and the rest of the app keeps working as usual.
8. **Given** a downloaded update fails to install, **When** the next launch happens, **Then**
   the previous version is still working, and Refract reports the failure.
9. **Given** the current version is already the latest, or the only newer release is a
   pre-release or a draft, **When** Refract checks for an update, **Then** no update is offered.

---

### User Story 4 - Uninstall (Priority: P2)

Refract can be removed from Windows Settings > Apps or an uninstall entry in its Start menu
folder. Uninstalling removes Refract's program files, Desktop shortcut, and Start menu entries.
It leaves Git, OMP, the GitHub CLI, the developer's repositories, worktrees, and OMP
conversations untouched. It asks whether to also delete Refract's own settings and session list
(default: keep them). If Refract is running, it asks the developer to close it first.

**Why this priority**: Removing Refract matters once it is installed and configured
(User Story 1), but it is needed far less often than updating, and nothing else in this spec
depends on it, so it sits alongside User Story 3 rather than ahead of installing.

**Independent Test**: With Refract installed and at least one repository and Session recorded,
uninstall it from Windows Settings > Apps, choose to keep settings and the session list when
asked, confirm the Desktop shortcut, Start menu entries, and program files are gone, and confirm
Git, OMP, the GitHub CLI, the developer's repositories, worktrees, and OMP conversations are all
still present.

**Acceptance Scenarios**:

1. **Given** Refract is installed, **When** the developer opens Windows Settings > Apps or the
   Start menu folder's uninstall entry, **Then** an uninstall action is available from either
   place.
2. **Given** the developer starts uninstalling, **When** Refract is running, **Then** the
   uninstaller asks the developer to close it first, rather than removing files out from under
   the running app.
3. **Given** the developer confirms the uninstall, **When** it completes, **Then** Refract's
   program files, Desktop shortcut, and Start menu entries are all removed, and Git, OMP, the
   GitHub CLI, the developer's repositories, worktrees, and OMP conversations are all untouched.
4. **Given** the uninstaller asks whether to also remove Refract's own settings and session
   list, **When** the developer leaves the default, **Then** they are kept; **When** the
   developer instead chooses to remove them, **Then** they are deleted along with the program
   files.

---

### User Story 5 - Publish a release (maintainer) (Priority: P3)

One maintainer action builds the installer from a version tag and publishes it, with its
checksum and release notes, as a private GitHub Release, so User Story 3 has something to find.
Releases that lack the installer or the checksum are ignored by the update check.

**Why this priority**: This is a maintainer-only action that produces the thing User Story 3
depends on. It ranks last because it has no direct developer-facing effect of its own, and a
manual release step could stand in temporarily while everything else in this spec is built.

**Independent Test**: Tag a version, run the one publish action, confirm a private GitHub
Release is created carrying the installer, its checksum, and release notes, then confirm a
release missing the installer or the checksum, and a release marked pre-release or left as a
draft, are never offered as an update by User Story 3's check.

**Acceptance Scenarios**:

1. **Given** a version tag, **When** the maintainer runs the publish action, **Then** it builds
   the installer from that tag and publishes a private GitHub Release carrying the installer,
   its checksum, and release notes.
2. **Given** a release that is missing the installer or its checksum, **When** the update check
   (User Story 3) runs, **Then** that release is ignored.
3. **Given** a release marked pre-release or left as a draft, **When** the update check runs,
   **Then** it is never offered as an update.

## Edge Cases

- Offline or a slow network during a dependency install, or during an update check or download:
  Refract resumes or retries rather than showing a half-installed state as success.
- A dependency's own installer is blocked, cancelled, or fails: the readiness checklist stays
  accurate and keeps offering Install for that item.
- Git is installed but not found on the path Refract searches, or several OMP versions are
  present: the checklist reports exactly what it found; an OMP version newer than supported is
  reported as unsupported with an explanation, never silently downgraded or treated as passing.
- Windows SmartScreen warns because the installer is unsigned: code signing is not part of this
  spec; see Assumptions.
- The developer installs or uninstalls while Refract is running: uninstall asks the developer to
  close it first (User Story 4); an install over a running instance still completes without
  Refract itself requesting administrator rights.
- A pre-release or draft release, or a release missing the installer or its checksum, is never
  offered as an update.
- The developer already has the latest version installed: no update is offered.
- A downgrade is never offered.
- The startup update check never delays showing the Refract window.
- An update finishes downloading but the machine shuts down before Refract's next quit: the
  install resumes the next time Refract quits.
- The disk is full during a dependency install, an update download, or an update install: the
  failure is reported with a reason, and nothing is left looking installed when it is not.
- The user data location is unchanged by installing or updating, so the developer's existing
  repositories, Sessions, and settings survive both.
- A running agent when the developer quits to install an update: quitting already stops every
  agent (spec 001 FR-031); the update only installs on a normal quit the developer already
  chose, and never forces one.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Refract MUST be distributed as a single downloaded installer file that installs
  Refract for the current Windows user only, without Refract requesting administrator rights.
- **FR-002**: Installing MUST add a Desktop shortcut and a Start menu entry, both using the
  Refract icon, and both MUST open Refract.
- **FR-003**: An install MUST make Refract appear in Windows Settings > Apps, showing its
  installed version.
- **FR-004**: Running the installer over an existing install MUST upgrade Refract in place and
  MUST keep the developer's repositories, Sessions, and settings intact.
- **FR-005**: The first-run readiness screen's checklist MUST offer an Install action next to
  each of Git and OMP whenever that item is missing or, for OMP, on an unsupported version.
- **FR-006**: Selecting a dependency's Install action MUST run that product's own official
  installer, show its progress and outcome inside Refract, and automatically re-check the
  checklist once it finishes.
- **FR-007**: The checklist MUST report OMP as unsupported, with an explanation, when a found
  installation is outside the supported 18.4.x/18.5.x range, rather than treating it as passing or
  silently installing a different version over it.
- **FR-008**: The checklist MUST show the GitHub CLI as an optional item, needed for updates
  (User Story 3) and for pull request access (spec 003 FR-027), and MUST be able to pass without
  it.
- **FR-009**: OMP's sign-in step MUST remain a manual action with its existing hint; Refract MUST
  NOT sign in to OMP on the developer's behalf.
- **FR-010**: A dependency install that is blocked, cancelled, or fails MUST show an actionable
  reason and MUST leave the checklist usable, with that item still offering Install.
- **FR-011**: Refract MUST NOT itself request administrator rights for any dependency install it
  runs from the checklist, though the dependency's own installer may make Windows ask.
- **FR-012**: Refract MUST check for a newer release at startup, and MUST offer a Check for
  updates action in Settings that checks again on demand.
- **FR-013**: When a newer release is found, Refract MUST show a badge near the app title, the
  new version's number, and a link to its release notes that opens in the system browser.
- **FR-014**: Selecting Update MUST download the release's installer, verify it against the
  release's published checksum before accepting it, and hold it ready to install; a download that
  fails verification MUST be discarded and reported, never installed.
- **FR-015**: A downloaded, verified update MUST install when Refract is next quit normally, and
  MUST NOT install, interrupt a running agent or turn, or force a quit at any other time.
- **FR-016**: The next launch after an update installs MUST run the new version.
- **FR-017**: When GitHub CLI access is unavailable (not installed, not signed in) or the machine
  is offline, the update check MUST say so in plain words, without an error toast, and the rest
  of the app MUST keep working as usual.
- **FR-018**: An update that fails to install MUST leave the previous version working, and
  Refract MUST report the failure.
- **FR-019**: The update check MUST NOT offer a pre-release or draft release, the version already
  installed, or a version older than what is installed.
- **FR-020**: The startup update check MUST NOT delay showing the Refract window.
- **FR-021**: Refract MUST be uninstallable from Windows Settings > Apps and from an uninstall
  entry in its Start menu folder.
- **FR-022**: Uninstalling MUST remove Refract's program files, Desktop shortcut, and Start menu
  entries, and MUST leave Git, OMP, the GitHub CLI, the developer's repositories, worktrees, and
  OMP conversations untouched.
- **FR-023**: Uninstalling MUST ask whether to also delete Refract's own settings and session
  list, defaulting to keeping them.
- **FR-024**: If Refract is running when an uninstall is started, the uninstaller MUST ask the
  developer to close it first.
- **FR-025**: One maintainer action MUST build the installer from a version tag and publish it,
  with its checksum and release notes, as a private GitHub Release.
- **FR-026**: The update check MUST ignore any release that lacks a published installer or a
  published checksum.
- **FR-027**: The Check for updates action and the update badge MUST be reachable and operable
  by keyboard, with a visible focus indicator, consistent with the rest of Settings (spec 004
  FR-016).
- **FR-028**: An interactive install MUST offer a "Create a desktop shortcut" checkbox on the
  installer's finish page, ticked by default; ticked, the install MUST leave a Desktop shortcut
  named Refract that opens the installed Refract and uses the Refract icon; unticked, it MUST NOT
  add one (issue #881).
- **FR-029**: A silent install (`/S`, the mode the in-app updater uses) MUST NOT add a Desktop
  shortcut and MUST leave an existing one in place (issue #881).
- **FR-030**: Uninstalling MUST remove the Refract Desktop shortcut and MUST NOT remove it during an
  upgrade (issue #881; refines FR-022).
- **FR-032** (issue #883): While Refract is open, it MUST re-check for a newer release every 4
  hours, the first re-check 4 hours after the startup check. A re-check MUST be skipped while
  another check, a download, or an install is in progress. Debug builds only MAY override the
  interval through `REFRACT_UPDATE_CHECK_INTERVAL_SECS`; release builds MUST ignore it.
- **FR-033** (issue #883): When a check finds a newer release, at startup or on a re-check,
  Refract MUST download it in the background through the same checksum and Authenticode
  verification as FR-014, with no click needed. A failure is reported as in FR-014 and FR-018.
- **FR-034** (issue #883): When the download is verified, Refract MUST show an "Update now"
  prompt as a row in the sidebar notice stack, next to the existing footer badge. Ignoring it
  keeps FR-015: the update installs the next time Refract quits.
- **FR-035** (issue #883): Selecting Update now MUST quit Refract, install the verified update,
  and start the new version. If any agent is mid-turn, Refract MUST first ask the developer to
  confirm ("N agents are running; restarting stops them"), and MUST NOT quit if they cancel.

### Key Entities

- **Release**: a published version of Refract, with a version number, an installer, a checksum,
  release notes, and a pre-release or draft flag.
- **Dependency**: one of Git, OMP, or the GitHub CLI, each with a found, missing, or unsupported
  state on the readiness checklist, and, for OMP, a check against the supported 18.4.x/18.5.x range.
- **Update**: a release newer than the installed version, once found; it moves from notified, to
  downloaded and checksum-verified, to installed at the next normal quit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer with no Refract installed can run the installer and reach first launch,
  including the first-run readiness screen, without any administrator prompt, every time.
- **SC-002**: 100% of installs over an existing install upgrade in place without losing the
  developer's repositories, Sessions, or settings.
- **SC-003**: Installing a missing dependency (Git or OMP) from the readiness checklist leaves
  the checklist showing it as found as soon as the dependency's own installer finishes, without
  the developer leaving Refract.
- **SC-004**: A developer can tell whether a newer version is available within 5 seconds of
  opening Settings or starting Refract.
- **SC-005**: 100% of installed updates are verified against their published checksum before they
  are installed.
- **SC-006**: 100% of update installs happen only at a normal quit the developer already chose,
  never interrupting a running agent or turn.
- **SC-007**: When GitHub CLI access is unavailable or the machine is offline, the update check
  reports this in plain words 100% of the time, with zero error toasts.
- **SC-008**: A pre-release, a draft, the already-installed version, or an older version is never
  offered as an update, across repeated checks.
- **SC-009**: Uninstalling removes 100% of Refract's own program files and shortcuts while
  leaving Git, OMP, the GitHub CLI, repositories, worktrees, and OMP conversations fully intact.
- **SC-010**: The startup update check adds no observable delay to showing the Refract window,
  compared with the same startup with the check disabled.

## Assumptions

- Code signing for the installer and its updates is out of scope for this spec. Windows
  SmartScreen is expected to warn on first run of an unsigned installer; whether and how to sign
  it is an open question, not a [NEEDS CLARIFICATION] item, because the feature can ship
  unsigned and be revisited later.
- Stuart installed OMP with OMP's own PowerShell install script (`irm https://omp.sh/install.ps1
  | iex`), which leaves a standalone executable under the user's local AppData. Whether that
  script can install a specific version, which version it installs by default, and whether it
  can run without prompts are unverified. Per the constitution's "Evidence before design"
  principle (IV), this must be probed on a clean profile and recorded in
  `docs/spike/FINDINGS.md` before the plan relies on it.
- Refract's install and update actions MUST keep OMP inside the supported 18.4.x/18.5.x range: Refract
  never runs OMP's own self-update to the latest version, and never leaves the developer on an
  unsupported OMP without saying so on the readiness screen (the app stays blocked until a
  supported version is present, as spec 001 FR-036 requires). OMP's sign-in (`omp login`) needs
  the developer, so the Install action ends by handing off to the readiness screen's sign-in
  step.
- Marking the GitHub CLI optional on the readiness checklist, and scoping it to updates and
  pull request access, is a reading of Stuart's answer, not a separately confirmed design. The
  GitHub CLI is not currently a listed Refract prerequisite in `README.md` (only Git and OMP are
  listed); this reading should be confirmed with Stuart before the plan commits to it.
- Refract does not embed or bundle the OMP SDK and drives OMP only as a separate process
  (constitution I); this spec's installer installs Refract itself, never OMP's own package.
- The update download and its install are driven from the main process only; the renderer reaches
  them through an allowlisted API, per the Electron security baseline (constitution V). The app
  window loads no remote content; release notes always open in the system browser.
- Windows 11 x64 is the only supported platform, consistent with the constitution. The audience
  is the developer and a small team on machines they manage themselves; no enterprise deployment,
  group policy, or per-machine silent install is in scope.
- No update ever installs without the developer's own click on Update, and no telemetry is added
  by this feature.
- The installer is a single file; this spec does not assume any particular packaging technology,
  only that one file is what the developer downloads and runs.
- Refract's data folder name is unchanged by this spec (`%APPDATA%/pinion`, per `README.md`);
  install, update, and uninstall all read and write state through that same, unchanged location.
- This spec depends on spec 001 (the first-run readiness screen and its setup message, FR-036;
  the rule that quitting already stops every agent, FR-031) and on spec 003 FR-027 (no stored
  GitHub token; access comes from the developer's own signed-in GitHub CLI), and extends spec
  004's Settings screen with the Check for updates action.
- This spec does not redesign the first-run readiness checklist's existing items (git found, OMP
  found and on the supported version, OMP signed in, from `docs/DESIGN.md`); it adds an Install
  action to the checklist that already exists.
- The update entry is also offered in the profile menu (spec 008): "Restart to update" with the new version while an update waits for the next quit, "Check for updates" otherwise. The update controls in Settings and the profile menu act on the same update.
