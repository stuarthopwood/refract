# Research: Installer and updates

Decisions for the implementation plan. "Verified" means observed in a probe in this repository
(scripts in `docs/spike/`, results in [FINDINGS](../../docs/spike/FINDINGS.md)). "Sourced" means
read from documentation or the actual source of a script, with the source named. "[INFERENCE]"
means neither. Versions are the npm `latest` (or the equivalent upstream release) read on
2026-10-02.

## 1. Packaging technology

**Decision**: `electron-builder@26.15.3`, Windows `nsis` target, with its *default* mode:
`oneClick: true` (the default), `perMachine: false` (the default). Per the configuration
reference (sourced: electron.build/nsis, read 2026-10-02): "If `oneClick` is `true` (default):
[`perMachine`] Whether to install per all users (per-machine)" — so the out-of-the-box
configuration already is a one-click, per-user (no install-mode page, no admin) installer; no
`oneClick: false` "assisted" mode is needed for FR-001's no-admin requirement. electron-builder
registers the uninstall entry under the Windows uninstall registry key derived from `appId`,
which is what makes an install appear in Windows Settings > Apps with its version (FR-003),
automatically, with no extra configuration (sourced, same page, "GUID vs Application Name").

**Rationale**: electron-builder is the de facto standard Electron packager (used by Electron's own
docs and most Electron apps), supports NSIS out of the box with no admin requirement, ships a
working uninstaller and uninstall-registry entry for free, and exposes `customUnInstall` /
`customUnInit` NSIS-script hooks (`build/installer.nsh`) for the keep-or-delete-data uninstall
prompt (FR-023) without replacing electron-builder's whole generated script (sourced, same page,
"Custom NSIS script").

**Alternatives considered**: `electron-forge` with the Squirrel.Windows maker (older, narrower
customisation surface, no documented custom-uninstall-page hook, and its own auto-update protocol
assumes a Squirrel update server rather than GitHub Releases); Velopack (a newer Squirrel
successor, less battle-tested with this app's native module, `koffi`, and would still need the
same custom `gh`-based update fetch this spec builds regardless of packager). Rejected: both would
still require the same bespoke update-fetch code below, for no packaging benefit.

**UNVERIFIED (first probe, T003)**: whether this app's specific native module (`koffi`, asar-unpacked
per spec 001 research.md decision 13) packages and runs correctly from the NSIS-installed
location, whether the resulting install truly requires no admin consent dialog in practice (not
just in configuration), and whether re-running the same installer upgrades in place without
disturbing `%APPDATA%/pinion` (registry.json, settings.json, processes.json — a different,
untouched folder from the NSIS install directory).

## 2. Custom uninstall page (keep or delete data) and the "close Refract first" uninstall guard

**Decision**: `build/installer.nsh`, included via `nsis.include` (the default path electron-builder
already looks for), defining `customUnInstall` (an NSIS `MessageBox MB_YESNO` asking whether to
delete `%APPDATA%/pinion`, default answer No/keep, consistent with FR-023's "defaulting to keeping
them") and `customUnInit` (a guard that detects a running Refract process — by a named mutex
Refract's main process already creates at startup for its single-instance lock, or a `tasklist`
check for `Refract.exe` — and shows a message asking the developer to close Refract before
continuing, FR-024).

**Rationale**: both macros are documented, general-purpose hooks (not "assisted installer only"),
so they work with the one-click NSIS target chosen in decision 1 (sourced, electron.build/nsis
"Custom NSIS script" macro list).

**Important caveat (sourced, same page, "Uninstaller lifecycle")**: the uninstaller that runs
during an uninstall or an in-place upgrade is the one written to disk by the *previously
installed* version, not the one embedded in the installer currently running. Because this spec
ships Refract's first-ever installer, there is no earlier version to be stuck on an old
uninstaller; every later packaging change to `installer.nsh` will only take effect the version
after it ships, which is a one-line fact worth keeping in this file for the next person who edits
`installer.nsh`.

**UNVERIFIED (probe, T004)**: whether electron-builder's default one-click NSIS template already
blocks or warns on a running instance during an in-place-upgrade install (which would make part of
`customUnInit`'s logic redundant for installs, though FR-024 only requires the guard for
*uninstall*), and whether the `customUnInstall` MessageBox actually appears and the default (No)
is honoured when the uninstaller is run both interactively (Settings > Apps) and silently (`/S`,
for the auto-update's install-on-quit, decision 6).

## 3. Update source and delivery (no stored token)

**Decision**: a hand-rolled updater in `src/main/update/`, not `electron-updater`. Main shells out
to the developer's already-signed-in `gh` CLI (resolved via the existing `resolveExecutable('gh')`
helper, `src/main/process/executables.ts`) for every GitHub call: `gh auth status` (availability),
`gh release list --json tagName,isDraft,isPrerelease --limit 20` then `gh release view <tag>
--json assets` (find the newest non-draft, non-prerelease release whose version is newer than
`app.getVersion()` and that carries both an installer and a checksum asset, FR-019, FR-026), and
`gh release download <tag> --pattern '*.exe' --pattern '*.sha256' --dir <scratch>` (fetch both
assets using `gh`'s own credential, never a token Refract stores or reads, FR-012/Assumptions,
same stance as spec 003 FR-027).

**Rationale, alternative rejected**: `electron-updater`'s built-in `GitHubProvider` either needs a
public repository or an explicit token (`GH_TOKEN` / `electronGhToken`) supplied to the app
[INFERENCE from its documented configuration options, not tested here] — exactly the "stored
token" this spec and spec 003 both rule out. It also has no hook to delegate the actual HTTP calls
to an external, already-authenticated CLI. A hand-rolled checker that only ever calls `gh` (which
owns and refreshes its own credential store) satisfies "no stored token" by construction.

**UNVERIFIED (probe, T005)**: `gh release download`/`gh release view` behaviour against this
*private* repository's releases while signed in (confirms the private-repo path actually works,
not just public-repo examples), and that `gh auth status` / a `gh release list` failure reliably
distinguish "not installed", "not signed in", and "offline" for FR-017's plain-words message.

## 4. Checksum verification

**Decision**: the maintainer's publish action (decision 8) uploads a second release asset, a plain
`<installer-name>.sha256` text file containing the hex SHA-256 digest. The update installer
downloads both assets, recomputes the digest of the downloaded installer with Node's built-in
`crypto.createHash('sha256')`, and compares it to the file's contents; a mismatch discards the
download and is reported, never installed (FR-014).

**Rationale**: no new dependency; Node's `crypto` module is already available in every Electron
main process, and a plain text digest file is the simplest format `gh release download`,
`sha256sum`, and a manual read can all agree on.

## 5. Install-on-quit mechanism

**Decision**: persist update progress in `updateState.json` (`src/main/store/updateState.ts`,
same atomic-write helper as `registry.json`/`settings.json`, `src/main/store/atomicJson.ts`). When
`phase` is `'downloaded'` (a verified installer is waiting) and Refract quits normally
(`before-quit`), main spawns a small detached helper (`src/main/update/installOnQuit.ts`) that
polls for Refract's own process id to exit, then runs the downloaded installer with the standard
NSIS silent switch `/S` (sourced: the NSIS user manual's documented silent-install switch, which
every NSIS-built installer honours, including electron-builder's output), and sets `phase:
'installing'` before the detached helper is spawned. Refract does not relaunch itself; the
developer's next launch (from the unchanged Desktop or Start Menu shortcut, which still points at
the same per-user install directory the silent run just overwrote in place) is the new version
(FR-016). At the next app start, Refract compares `app.getVersion()` to the persisted target
version: a match clears `updateState.json` to `idle`; a mismatch sets `phase: 'failed'` and reports
it (FR-018).

**Why a detached wait-then-run helper, not installing from inside `before-quit` directly**: the
installer must not run while Refract's own executable file is still open (the install replaces
it); waiting for Refract's own pid to exit before running `/S` avoids a file-lock race without
needing any `/S` retry loop inside the NSIS script itself.

**Resuming after an unexpected shutdown (edge case)**: no special resume code is needed. If the
machine shuts down between `'downloaded'` and the next normal quit, `updateState.json` already
says `'downloaded'` with a verified `installerPath`; the very next normal quit's `before-quit`
handler sees that same state and runs the same install-on-quit path, which is exactly "resumes the
next time Refract quits."

**UNVERIFIED**: covered by the packaging probes (decisions 1 to 2, T003/T004) since this depends
on the real NSIS-built installer's silent-run behaviour.

## 6. Dependency installs from the first-run readiness screen

**Decision**: `src/main/dependencyInstall.ts` with one function per dependency, each downloading
that vendor's own official installer over plain HTTPS (no `gh` needed; these are public, unrelated
repositories) to a scratch file under `app.getPath('temp')`, then running it with an
unattended/no-admin flag set, reporting progress through a new `readiness:install-progress` event,
and re-running `readiness.check()` on completion (FR-005, FR-006).

- **Git for Windows**: fetch `https://api.github.com/repos/git-for-windows/git/releases/latest`
  (public, unauthenticated), pick the `-64-bit.exe` asset, run it with
  `/VERYSILENT /NORESTART /NOCANCEL /SP- /CURRENTUSER` (sourced:
  gitforwindows.org/silent-or-unattended-installation for `/VERYSILENT /NORESTART /NOCANCEL /SP-`;
  `/CURRENTUSER` is Inno Setup's standard command-line override for a per-user, no-admin install,
  **not confirmed to be enabled** by Git for Windows' own `install.iss` — the documented default
  install directory is `C:\Program Files\Git`, which needs admin). **UNVERIFIED (probe, T002)**:
  whether `/CURRENTUSER` (optionally with `/DIR="%LOCALAPPDATA%\Programs\Git"`) actually produces a
  no-admin install on this installer; if it does not, the Install action falls back to running the
  installer without `/VERYSILENT` so Git's own installer can show its normal (possibly
  UAC-elevated) prompt, which FR-011 explicitly allows ("though the dependency's own installer may
  make Windows ask").
- **GitHub CLI**: fetch `https://api.github.com/repos/cli/cli/releases/latest` (public), pick the
  `_windows_amd64.msi` asset, run `msiexec /i <path> /quiet /norestart`. **UNVERIFIED (probe,
  T002)**: whether the official MSI installs per-machine (needing elevation, which Windows itself
  may prompt for under FR-011) or supports a per-user target; either way, a failure is reported per
  FR-010 rather than silently treated as success.
- **OMP**: read directly from OMP's own install script (sourced, fetched 2026-10-02 from
  `https://omp.sh/install.ps1`, which 302s to
  `https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1`): it already
  supports exactly what decision 7 below needs, `-Binary -Ref <tag>`, which downloads a named
  GitHub release's `omp-windows-<arch>.exe` straight to `%LOCALAPPDATA%\omp\omp.exe` (an
  `$env:PI_INSTALL_DIR` override exists but is not needed) and adds that folder to the **User**
  (not machine) `PATH` — fully unattended, no prompts anywhere in the script, no admin. The Install
  action invokes `powershell -NoProfile -NonInteractive -Command "& ([scriptblock]::Create((irm
  https://omp.sh/install.ps1))) -Binary -Ref <pinned-tag>"` (resolved via `resolvePowerShell()`,
  `src/main/process/executables.ts`). A found-but-unsupported existing OMP is left alone — the
  Install action always targets the pinned 18.4.x tag, never "whatever is latest", so it can only
  ever add or replace the standalone binary with a supported one, never silently upgrade past it.

**UNVERIFIED (probe, T001, first task — constitution IV, and the spec's own Assumptions call this
out explicitly)**: whether the exact tag name OMP's GitHub releases use matches what
`-Ref` expects and what `omp --version` later reports (for example `v18.4.5` versus `18.4.5`); and
whether, after `Install-Binary` runs, Refract's own re-check can find the freshly installed
`omp.exe` immediately. **Decision made without Stuart, recorded here because the script already
answers "can it pin a version" and "can it run unattended" (yes to both) that the spec flagged as
open**: since a running process's in-memory `PATH` does not pick up a child script's `User`-scope
`SetEnvironmentVariable` write, Refract's post-install re-check must probe the known fixed path
`%LOCALAPPDATA%\omp\omp.exe` directly (not rely on `resolveExecutable`'s `PATH` search) immediately
after a successful OMP Install action, falling back to a full `readiness.check()` (which does use
`PATH`, and will see it correctly on Refract's *next* restart once the shell/process PATH catches
up) when that direct path is itself not where OMP reports it installs.

## 7. OMP version pinning policy

**Decision**: the Install action for OMP always targets the newest tag matching the supported
`18.4.x` line (the same `OMP_VERSION_SUPPORTED_RE` pattern already in `src/main/readiness.ts`),
resolved once at build time as a constant (for example `OMP_PINNED_TAG`), not "whatever `-Ref`
defaults to" (which would be bun-or-latest-binary, an unpinned, unsupported version per
constitution IV and the spec's Assumptions: "never run OMP's own self-update to the latest
version"). If the probe (decision 6) finds no tag cleanly maps to a reported `18.4.x` version, the
fallback is to run the plain `Install-Binary` default (latest) and then immediately re-run
`readiness.check()`: if the result is unsupported, the Install action reports failure with an
actionable message rather than ever leaving an unsupported version looking like success (FR-007,
consistent with the existing `checkOmp()` behaviour).

## 8. Maintainer release-publish action

**Decision**: `.github/workflows/release.yml`, triggered on a pushed tag matching `v*.*.*`. Steps:
checkout, set up Node/pnpm, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm exec
electron-builder --win --publish never` (build only; electron-builder's own GitHub publish step is
not used, since the release is assembled explicitly in the next step to control the checksum
asset and the prerelease flag), compute the installer's SHA-256 and write `<installer
name>.sha256`, then `gh release create <tag> <installer> <checksum file> --repo
stuarthopwood/refract --generate-notes` (private repository releases are the default for a private
repo; `--prerelease` is added when the tag has a `-rc`/`-beta`/`-alpha` suffix). A guard step fails
the job if the tag's numeric part does not equal `package.json`'s `"version"` field, so a release
can never be cut from an un-bumped `package.json` (FR-025).

**Rationale**: a CI workflow (not a local script) means publishing never depends on a maintainer's
own machine state, and uses the Actions-provided, ephemeral `GITHUB_TOKEN` to call `gh`/the GitHub
API for *this one job* — a different concern from, and not in conflict with, the "no stored token"
rule, which is about Refract's own shipped application code never reading or persisting a
developer's personal access token.

**Alternative rejected**: a local maintainer script (`pnpm release`) run by hand — rejected because
it couples publishing to whichever machine the maintainer happens to be on, and a CI workflow is
no more work to write.

## 9. Version comparison

**Decision**: a small hand-written `compareVersions(a, b)` (three-part numeric compare) in
`src/main/update/UpdateChecker.ts`, not the `semver` npm package.

**Rationale**: FR-019 already requires pre-release and draft releases to be filtered out entirely
at the GitHub-Release level before a version ever reaches the comparison step, so every version
this spec compares is a plain `X.Y.Z` tag with no pre-release suffix or build metadata to parse —
the one case `semver`'s extra complexity exists for. Checked `semver@7.8.5` on npm as the
alternative; not used.

## 10. Readiness checklist: GitHub CLI as a fourth, optional check

**Decision**: `Readiness` (`src/shared/ipc.ts`) gains a fourth field, `github: Check`, alongside
the existing `git`, `omp`, `ompSignedIn`; `allPass` in `Readiness.tsx` is computed over the
existing three only (`CHECK_ORDER` stays `['git', 'omp', 'ompSignedIn']`), so a missing or
signed-out GitHub CLI never blocks **Add repository** (FR-008). The row still renders with its own
label and an Install action, marked "optional".

**Decision made without Stuart, recorded per this session's instructions**: the spec's own
Assumptions flag this reading as not yet separately confirmed. The plan proceeds with it as
written (optional checklist item, scoped to updates and spec 003's pull-request access) because
it is the direct, conservative reading of Stuart's clarification answer, and nothing in the spec
contradicts it.

## 11. Badge placement ("near the app title")

**Decision**: until spec 001's own convergence work (tasks T100/T101, not yet done — see
`specs/001-core-session-workspace/tasks.md`) adds a custom integrated title row, this spec's
update badge and its "Check for updates" action live in the existing
`src/renderer/features/status-bar/StatusBar.tsx`, the one surface in the app today that already
hosts small, always-visible, cross-cutting indicators (the Approval mode switch, the low-memory
warning). This is a dependency note, not a task against another spec: spec 004's future Settings
screen and spec 008's future profile menu each get their own permanent entry later, both calling
the same `updates.check()` / `updates.getState()` / `updates.install()` API this spec builds, per
the Acceptance section of `plan.md`.

## 12. Icon

**Decision**: `build/icon.ico` is a placeholder dependency on issue #91 ("Design a logo and app
icon for Refract"), not designed by this plan. The packaging task (T006) wires whatever `.ico`
file that issue delivers into `nsis`'s (and the `BrowserWindow`'s, already set elsewhere) icon
option; until #91 lands, the task notes the dependency rather than fabricating a design.

## Unknowns that remain, and where they are resolved

| Unknown | Resolved by |
|---|---|
| Can OMP's install script pin a version and run unattended, and does the pinned tag match what `omp --version` reports | T001 (first task) |
| Can Git for Windows and the GitHub CLI install silently without admin | T002 |
| Does the packaged NSIS installer truly need no admin, register in Apps & Features with its version, and upgrade in place | T003 |
| Does the custom uninstall keep/delete-data page and the running-instance guard work, interactively and under `/S` | T004 |
| Does `gh release download`/`view` work against this private repository while signed in, and do `gh auth status`/failures distinguish not-installed, signed-out, and offline | T005 |
