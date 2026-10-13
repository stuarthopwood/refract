# Installer and update probes (R11a, issue #794)

Probes only. No `src-tauri` code changed in this lane; this document is the handoff to R11b
(issue #794's "redo on the Tauri bundler" / "port to Rust" rows). Every finding below was
produced by a real command run on this machine (verified), not inferred, unless marked
`[INFERENCE]`. Mined reference code is `git show origin/spec-006-impl:<path>` — real, but
**not finished** (per the epic: stalled round-2 quality-gate fixes, no PR); do not merge that
branch.

## Recommended design for R11b (summary)

1. **Installer technology**: Tauri's NSIS bundler, not WiX/MSI. `tauri.conf.json`'s
   `bundle.windows.targets` currently builds both `["nsis", "msi"]`; drop `"msi"` unless a
   reason to keep it shows up later — spec 006 only ever specified one installer technology
   (electron-builder's NSIS), and `installerHooks` (the uninstall keep/delete-data prompt,
   below) is an NSIS-only mechanism with no WiX equivalent already wired up.
2. **Per-user, no-admin install**: already correct with **zero config changes**. Tauri's NSIS
   `installMode` defaults to `"currentUser"` (HKCU-based, no admin prompt) — confirmed live
   (below). Electron's `installMode: currentUser` from `electron-builder.yml` has no Tauri
   equivalent to add; it is already the bundler's default.
3. **Desktop shortcut, Start Menu entry, Apps & Features entry**: already correct with zero
   config changes — Tauri's generated NSIS script creates and removes all three automatically,
   including through a redirected (OneDrive) Desktop folder. Confirmed live (below).
4. **Keep-or-delete-data uninstall prompt and running-instance guard (FR-023, FR-024)**: not
   present by default; port `build/installer.nsh`'s two macros from `spec-006-impl` into a new
   `.nsh` file wired through `bundle.windows.nsis.installerHooks`, using
   `NSIS_HOOK_PREUNINSTALL` for the running-process guard and `NSIS_HOOK_POSTUNINSTALL` (or
   `NSIS_HOOK_PREUNINSTALL`, see open question below) for the keep/delete-data `MessageBox`.
   The `tasklist`/`find` running-process check and the `/SD`-silent-default `MessageBox` calls
   port verbatim; the executable name to check is `refract-tauri.exe` (`MAINBINARYNAME`), not
   `Refract.exe` — confirm the final production binary name before porting the literal string.
5. **WebView2**: leave the bundler default (`downloadBootstrapper`, silent). WebView2 Evergreen
   Runtime is already present system-wide on every realistic Windows 11 target (confirmed via
   registry, below); the bootstrapper's job in that case is a fast no-op version check, not a
   ~150 MB download. No `webviewInstallMode` override needed.
6. **Update source**: **do not use `tauri-plugin-updater`.** Confirmed (below) that its
   `endpoints` mechanism cannot carry an `Authorization` header to the actual asset download URL
   for a private GitHub repo — only the real-world workaround (a self-hosted proxy holding its
   own stored GitHub token) solves it, and that violates spec 006's explicit "no stored token"
   requirement. The mined `spec-006-impl` hand-rolled checker
   (`src/main/update/UpdateChecker.ts`/`UpdateInstaller.ts`, through the developer's own
   signed-in `gh`) is the right design and ports to Rust almost line-for-line; see "Update
   source" below for the exact port notes.
7. **Code signing**: recommend **Azure Artifact Signing** (~$9.99/month, CI/CD-friendly, no
   hardware token) over a traditional OV certificate ($150-300/yr) or EV ($400+/yr, no longer
   buys SmartScreen bypass since 2024) — **this is a cost/business decision, not fully
   settleable from source**; flagging it to Stuart is still needed before #341/#349 (the release
   workflow and final gate) can close. Geographic eligibility ([INFERENCE] not verified:
   Azure Artifact Signing individual-developer coverage is USA/Canada only) needs Stuart to
   confirm before committing to it over an OV certificate.

## 1. Shell-independent probes (#212, #218, #236)

### #212 — OMP install script

Read the live script (`https://omp.sh/install.ps1`, redirects to
`raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1`) in full before running
anything, because `Install-Binary` (the `-Binary -Ref v<tag>` path `dependencyInstall.ts` already
uses) has **two real, persistent side effects on the actual logged-in user's account** that a
scratch `$env:PI_INSTALL_DIR` override does **not** contain:

- `[Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")` — writes
  `HKCU\Environment\PATH` directly, for the real OS user, regardless of any per-process env
  override. On a shared dev machine this permanently pollutes Stuart's actual PATH with a
  one-off scratch path.
- `Configure-BashShell` writes `$env:USERPROFILE\.omp\agent\settings.json` — overridable by
  overriding `USERPROFILE` for the child process, but the PATH write above is not.

Given the "never modify the user's default profile/environment" constraint, I did **not** run
the live script's `Install-Binary` end to end. Instead I replicated its exact download+verify
logic by hand (same API, same checksum algorithm, no PATH write):

- Script resolves `$BuildUrl/api/products/omp/versions/<version>/windows-x86_64` (no `v` prefix)
  for a pinned `-Ref v<version>`, or `.../latest/windows-x86_64?channel=stable` with no `-Ref`.
- **Confirmed live**: `versions/18.10.4/windows-x86_64` → a full `{build, file, download}` JSON
  (version `18.10.4`, file `omp-windows-x64.exe`, a 64-hex-char `sha256`, a signed
  `r2.cloudflarestorage.com` download URL). `versions/18.8.0/windows-x86_64` and
  `versions/18.4.4/windows-x86_64` both → `{"error":"no_build"}` — confirms research.md's
  "a found-but-unsupported existing OMP tag" failure shape is a clean, parseable JSON error, not
  an HTTP error; `Install-Binary`'s own `if (-not $Version -or ...) { throw "Unexpected answer
  from $ApiUrl" }` check does correctly catch this shape (none of `build`/`file`/`download` are
  present on an error response, so `$Version` is `$null`).
- Downloaded the real `omp-windows-x64.exe` asset for version `18.10.4` to a scratch dir;
  SHA-256 matched the API's `file.sha256` exactly.
- Ran the just-downloaded `omp.exe` **by its full path, from a brand-new child shell that never
  inherited any PATH change** (there was none, since I never wrote one) — it ran immediately
  (`omp/18.10.4`). This empirically confirms research.md decision 6/7's reasoning: a fresh child
  process spawned by the app does **not** pick up a registry PATH write made by a script it just
  ran (standard Windows behavior: a process's env block is copied from its parent at spawn time,
  not re-read from the registry, and only Explorer-spawned children after a
  `WM_SETTINGCHANGE` broadcast would see it) — `dependencyInstall.ts`'s `primeIfInstalled`
  (probe the known fixed install path directly, never rely on PATH) is the correct, necessary
  mitigation and should port to Rust as-is.
- `OMP_PINNED_TAG = 'v18.5.1'` in the mined code is now stale: the machine's own installed `omp`
  reports `18.10.1`, and the build API's `latest` channel reports `18.10.4`. R11b must pick a
  current pinned tag before porting; the mechanism (pin, don't track latest) is unaffected.
- Installed `omp` here is `18.10.1` via `omp --version`, not the `18.4.4`/`18.8.0` figures
  recorded in older `docs/spike/FINDINGS.md` entries — this machine's OMP has moved on since
  those were written; not a contradiction, just time passing.

### #218 — Git for Windows and GitHub CLI silent installs

**Git for Windows**: downloaded the real latest installer (`v2.56.0.windows.2`,
`Git-2.56.0.2-64-bit.exe`, same version already installed system-wide via Program Files) and ran
it twice, unattended, targeting a scratch directory so it could never collide with the existing
install:
```
Git-2.56.0.2-64-bit.exe /VERYSILENT /NORESTART /NOCANCEL /SP- /CURRENTUSER /DIR=<scratch>
```
Both runs **exited 2** after roughly two minutes, with **no log file** (`/LOG=` was set) and
**no files written** to the scratch directory at any point — confirmed by listing the target
immediately after each run. Per Inno Setup's own documented exit codes, `2` is "the user clicked
Cancel... or chose No on the opening prompt", which is surprising given `/VERYSILENT /NOCANCEL`;
since no log was ever created, the installer aborted during its own `InitializeSetup()`, before
logging starts. **Root cause unconfirmed** — plausibly Git for Windows' own installer script
detects the already-present system Git (via a registry/version check unrelated to the `/DIR`
target) and refuses to proceed outside its normal upgrade path, but this was not instrumented
further (would need Process Monitor or a machine with no Git at all, out of this probe's scope).
Practically this is moot for Refract's real flow: `readiness.check()` only shows an Install
button for a **missing** dependency, so this exact scenario (Git already present, forcing a
second parallel install) never happens in production — worth a note on the issue, not a blocker.
No system state was touched by this probe (confirmed: no scratch directory, no registry key, no
log file ever existed).

**GitHub CLI**: the mined `dependencyInstall.ts` downloads the official **MSI**
(`gh_<version>_windows_amd64.msi`) and runs `msiexec /i <path> /passive /norestart`. This machine
already has GitHub CLI installed via that exact MSI path (`Program Files\GitHub CLI\gh.exe`,
confirmed via `where gh`); MSI installers are **inherently per-machine** (no per-user install
mode, confirmed via `cli/cli`'s own release assets and `dependencyInstall.ts`'s own comment "the
official MSI is per-machine only"), so there was no safe way to test it against a scratch target
without risking the real, shared, already-installed product entry (product-code collision on
reinstall/repair). **Did not run it live.**

Instead, tested the genuinely safe alternative: the GitHub CLI's own **portable zip** release
(`gh_2.102.0_windows_amd64.zip`, same release, `bin/gh.exe` + `LICENSE`, no installer at all).
Extracted to a scratch directory and ran `gh.exe --version` directly — worked immediately,
no admin, no registry write, no MSI involved (`gh version 2.102.0 (2026-09-30)`). **Recommend
R11b switch the GitHub CLI dependency-install action from the MSI to this portable zip**: it is
the only one of the two that is actually no-admin by construction (FR-011 only *allows* Windows
to prompt for Git; it does not require defaulting to a mechanism that always needs elevation),
and it sidesteps the untested per-machine-only MSI path entirely. Extract to
`%LOCALAPPDATA%\refract\tools\gh\gh.exe` (or similar fixed, `primeIfInstalled`-style path) instead
of invoking `msiexec`.

### #236 — `gh release` against a private repo

Ran the full probe plan against the real private `stuarthopwood/refract` repo, as the already
signed-in `gh` account (`stuarthopwood`, `copilot/gist/read:org/read:packages/repo/workflow`
scopes):

- `gh release create <scratch-tag> --repo stuarthopwood/refract --prerelease <dummy.exe>
  <dummy.exe.sha256>` — created cleanly.
- `gh release list --repo stuarthopwood/refract --json tagName,isDraft,isPrerelease,createdAt`
  — exact field names round-trip as `UpdateChecker.ts` expects.
- `gh release view <tag> --json assets` — returned both assets with `name`, `size`, a `digest`
  field (`sha256:<hex>`, a convenience GitHub now returns directly — `UpdateInstaller.ts`
  recomputes the hash itself with Node's `crypto` rather than trusting this field, which is still
  the right call: this `digest` is GitHub's own metadata, not a provenance guarantee over the
  download).
- `gh release download <tag> --repo ... --pattern '*.exe' --pattern '*.sha256' --dir <scratch>
  --clobber` — both files downloaded; SHA-256 of the downloaded `.exe` matched the value computed
  before upload exactly (`570caee7...f516bfc`).
- `gh release delete <tag> --repo ... --yes --cleanup-tag` — removed the scratch release and its
  tag cleanly; confirmed empty `gh release list` afterward. No trace left in the real repo.
- **Signed-out distinguishability**: did **not** run `gh auth logout` (would deauth the real,
  shared, actively-used credential — other agents and Stuart's own tools depend on it). Used
  `GH_CONFIG_DIR=<scratch, empty dir>` instead (gh's own documented env override, confirmed via
  `gh help environment`) to get a genuinely fresh, isolated "never signed in" gh state without
  touching the real one. Result: `gh auth status` → exit 1, "You are not logged into any GitHub
  hosts."; `gh release list` (same isolated config, no TTY) → exit 4, "To use GitHub CLI in
  automation, set the GH_TOKEN environment variable." Both are clearly distinguishable from a
  normal failure.
- **Offline distinguishability**: simulated with an unreachable `HTTPS_PROXY`/`HTTP_PROXY`
  (`http://127.0.0.1:1`, nothing listens there) rather than touching the real network adapter —
  `gh release list` → `Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp
  127.0.0.1:1: connectex: ...actively refused...`. This is a distinct, recognizable "network
  failure" shape, different from both signed-out messages above. `UpdateChecker.ts`'s
  `githubCliStatus`/`GhError.code` three-way split (`not-installed` / `offline` / ok) is
  confirmed implementable: "not logged into any GitHub hosts" and "set the GH_TOKEN..." both map
  to a signed-out case, anything shaped like a `dial tcp`/`proxyconnect` error maps to `offline`.

## 2. Tauri NSIS per-user install (new probe, #223/#230 redone on the new bundler)

Built the real bundle: `pnpm exec vite build --config tauri.vite.config.ts` then
`CARGO_TARGET_DIR=C:/Users/shopwood/.cargo-target/refract pnpm exec tauri build` (NSIS + MSI
targets, both already configured in `tauri.conf.json`). Produced:
- `.../release/bundle/nsis/Refract Rust Preview_0.1.0_x64-setup.exe` (5.57 MiB)
- `.../release/bundle/msi/Refract Rust Preview_0.1.0_x64_en-US.msi` (6.96 MiB)

The experimental build's `productName`/`identifier` ("Refract Rust Preview" /
`com.stuarthopwood.refract.rust-preview`) are already distinct from Stuart's real shipped
Electron "Refract", so installing it for real cannot collide with his existing app.

**Installed silently twice**, uninstalled both times, confirmed fully clean each time:

1. `Refract Rust Preview_0.1.0_x64-setup.exe /S` (no `/D`): installed to the bundler's own
   default, `%LOCALAPPDATA%\Refract Rust Preview` — **no admin prompt, exit 0, under 2
   seconds.** Confirmed via registry: `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\
   Refract Rust Preview` was written (not `HKLM`) — this **is** the per-user, no-admin install
   FR-001 requires, and it is the bundler's default with zero config (`nsis.installMode` defaults
   to `"currentUser"`, confirmed from `tauri-utils`' own documented default). Start Menu shortcut
   created (`...\Start Menu\Programs\Refract Rust Preview.lnk`). **Desktop shortcut also
   created** — initially missed because this account's Desktop is redirected to
   `C:\Users\shopwood\OneDrive - Hearst\Desktop` (confirmed via
   `HKCU\...\Explorer\User Shell Folders\Desktop`); Tauri's generated NSIS script resolves
   `$DESKTOP` through the Shell API so it correctly follows that redirection, unlike a hardcoded
   `%USERPROFILE%\Desktop` guess would. `uninstall.exe /S` removed the install directory, the
   Start Menu and (redirected) Desktop shortcuts, and the registry key — confirmed empty
   immediately for the directory/shortcuts, and the registry key needs **a roughly 1-2 second
   grace period** after the uninstaller process exits before it disappears (NSIS's uninstaller
   relaunches a copy of itself to delete the original `uninstall.exe`, which is still holding the
   registry key open at the instant `uninstall.exe` itself returns) — note this for any
   CI/verification script that checks "is it gone" right after the process exits.
2. `Refract Rust Preview_0.1.0_x64-setup.exe /S '/D=C:\tmp\r11a-794-probe\tauri-scratch2'`
   (**note the single quotes** — see below): installed to the literal scratch path, confirmed via
   the registry's own `InstallLocation`/`DisplayIcon` values. Uninstalled the same way, fully
   clean after the same short grace period.

**Bash/MSYS quoting pitfall (not a Tauri bug) found along the way**: an *unquoted*
`/D=C:\tmp\...\tauri-scratch` argument from this bash shell is silently mangled — bash's own
unquoted-backslash escaping consumes each backslash before a letter, so the installer actually
receives something like `/D=C:tmpr11a-794-probetauri-scratch` and falls back to its default
install location with no error. **Always single-quote a Windows-style `/D=` (or any
backslash-bearing) argument from this harness's bash**, e.g. `'/D=C:\path\to\dir'`. I confirmed
this against tauri-apps/tauri#6928 (closed in 2023): the current `installer.nsi` template already
has the `${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"` guard that issue asked for, so `/D=`
genuinely does work when correctly quoted — my first test's failure was the shell, not the
bundler.

**Open question for R11b**: `uninstallerHooks`'s four hook points
(`NSIS_HOOK_PRE/POSTINSTALL`, `NSIS_HOOK_PRE/POSTUNINSTALL`) are confirmed to exist in the
current template (`crates/tauri-bundler/.../nsis/installer.nsi` on `tauri-apps/tauri@dev`,
matching installed `tauri` 2.12.3's behavior), but I did not build a real `.nsh` hook file and
bundle it in this probe (out of scope: the issue's probe list does not ask for the ported hook
itself, only for the per-user/no-admin/uninstall-keep-data *mechanism* to be confirmed usable).
R11b should also check whether this template exposes an NSIS LogicLib variable equivalent to
electron-builder's `${isUpdated}` (used by the mined `installer.nsh` to skip the keep/delete-data
prompt during a silent in-place upgrade) — I did not find one by inspection of the template
excerpt read for this probe; confirm by reading the full `installer.nsi` before porting, or by
testing an actual upgrade-over-upgrade silent run.

## 3. WebView2 runtime

Tauri's `WebviewInstallMode` enum (`tauri-utils` 2.10.1): `Skip`, `DownloadBootstrapper`
(**default**, `{silent: true}`), `EmbedBootstrapper`, `OfflineInstaller`, `FixedRuntime`. This
machine already has the WebView2 Evergreen Runtime installed **system-wide** (confirmed:
`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\
{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` → `pv = 155.0.4283.45`), consistent with it shipping as
part of Windows 11 (21H2+) rather than something apps must bundle. On a target machine like this
one, `DownloadBootstrapper`'s own "download and run the ~2 MB bootstrapper" step is effectively a
fast version check that exits immediately because the runtime is already current — **no 150 MB+
runtime download ever happens on a realistic Windows 11 target.** Recommend leaving the bundler
default as-is; `OfflineInstaller`/`FixedRuntime` would only matter for an air-gapped or
locked-down target with no network at install time, which is not a stated requirement here.
**Not independently tested**: actual installer behavior on a machine with *no* WebView2 Runtime
at all (every machine available for this probe already has it) — flag this as untested rather
than claim it.

## 4. Update source

Confirmed via the Tauri docs and a real community thread
(`github.com/orgs/tauri-apps/discussions/7553`, "Private updates with GitHub Releases", 2023 to
2025, still open/unanswered by the Tauri team) that `tauri-plugin-updater`'s `endpoints`
mechanism has a structural gap for a private repository:

- The `check()` call's own request to `endpoints` *can* carry custom headers
  (`CheckOptions.headers`), so an `Authorization` header reaching **your own** endpoint is fine.
- But the JSON response's `platforms.<target>.url` field is a second, separate URL the updater
  fetches on its own — for a private GitHub release this has to be either (a) a public,
  unauthenticated asset URL (defeats "private"), or (b) a short-lived pre-signed URL your server
  minted using a server-held token, or (c) a URL on your own proxy that re-authenticates per
  request using a server-held token. **Every real option in the community thread needs a
  server-side stored GitHub token** (a self-hosted Deno/other proxy) — directly violating spec
  006's "updates ... read through the developer's signed-in `gh` ... no token stored" requirement
  for Refract specifically (a one-maintainer private repo, not a fleet-managed product with a
  server component).
- **Decision confirmed, not just assumed**: the mined hand-rolled `UpdateChecker.ts`/
  `UpdateInstaller.ts` approach (shell out to the developer's own already-authenticated `gh`
  CLI for `release list`/`view`/`download`, never a token) is the only one of the two that
  actually satisfies the "no stored token" constraint. Port it to Rust
  (`src-tauri/src/updates/`, per the issue's own "Ownership and dependencies" note) using
  `tokio::process::Command` to shell out to `gh` the same way `src-tauri/src/omp/process.rs`
  presumably already shells out to `omp`/`git` elsewhere in this port — re-use whatever
  `resolveExecutable`-equivalent path-resolution helper that module already has rather than
  inventing a second one.
- `compareVersions` (hand-written three-part numeric compare, not `semver`), the `RELEASE_TAG_RE`
  guard, the busy-phase/automatic-vs-manual check gating, and the checksum-verify-before-install
  logic in `UpdateInstaller.ts` all port essentially as-is (same shape, same reasoning, written
  for a different language).
- Install-on-quit (`installOnQuit.ts`'s WMI/`Win32_Process.Create` breakaway-from-job trick) is
  Electron/Node-specific plumbing for escaping a Job Object from inside one; Rust's own Job
  Object handling (`src-tauri/src/process/job_object.rs`, per the repo listing) needs the
  equivalent escape, which may look different in `windows-rs` — **not evaluated in this probe**
  (out of scope: this is implementation, not a probe question), flagging it as a real port task
  for R11b, not a trivial file copy.

## 5. Code signing

See the "Recommended design" summary above for the decision; supporting facts (Microsoft Learn,
`code-signing-options`, updated 2026-08-29):

| Option | Cost | SmartScreen | Notes |
|---|---|---|---|
| Azure Artifact Signing | ~$9.99/mo | Reputation builds over time (no instant bypass) | CI/CD-native, no hardware token; **individuals: USA/Canada only** |
| OV certificate (DigiCert/Sectigo/etc.) | $150-300/yr | Same as above | Needs an HSM/hardware token since June 2023; worldwide |
| EV certificate | $400+/yr | **Same as OV since 2024** — no longer bypasses SmartScreen | Not worth the premium anymore |
| Self-signed | Free | Strong block for any user without the cert manually trusted | Dev/internal only |
| Unsigned | Free | Strong SmartScreen block; some enterprises block entirely | Current state (`signExecutable: false` was the Electron build's explicit choice per spec.md) |

This is the kind of decision spec 006's own assumptions file already flagged as "a later, separate
decision" — it is a real cost/business call for Stuart, not something resolvable from source or a
probe. Recommend Azure Artifact Signing conditional on confirming geographic eligibility; the
actual choice and certificate purchase remain open for #341/#349 (Stuart decided per the epic
body, under "Probes first" item 4, that this stays a probe-and-flag item, not an implement item).

## Mined reference inventory (from `origin/spec-006-impl`, read via `git show`, not checked out)

For R11b's direct use when porting — file, and the one-line reason it is/ is not a straight port:

- `build/installer.nsh` → port both macros into a new Tauri `installerHooks` `.nsh` (see
  "Recommended design" item 4 and the NSIS open question above).
- `electron-builder.yml` → superseded entirely by `tauri.conf.json`'s `bundle.windows` section;
  nothing to port, its `nsis.oneClick`/`perMachine` settings are Tauri's bundler defaults already.
- `src/main/update/UpdateChecker.ts`, `UpdateInstaller.ts` → port to Rust near-verbatim logic
  (see "Update source" above); `installOnQuit.ts` needs real Job-Object-escape redesign in Rust,
  not a line-for-line port.
- `src/main/dependencyInstall.ts` → port `installGit`/`installOmp` logic close to as-is;
  **do not port `installGithubCli`'s MSI invocation** — use the portable-zip approach confirmed
  above instead. `primeIfInstalled`'s "probe the known fixed path, never trust PATH" pattern is
  confirmed necessary and correct (see the OMP probe above) and should port unchanged.
- `specs/006-installer-and-updates/{spec,research,data-model,contracts/ipc,tasks}.md` → the
  requirements and `UpdateState`/`DependencyInstallProgress` IPC shapes are unchanged by the
  shell switch; R11b can carry those type definitions into the new Rust IPC channels
  (`check:parity`, per the epic) without re-deriving them.
