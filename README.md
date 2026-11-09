# Refract

A desktop harness for [OMP (oh-my-pi)](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent). Refract hosts OMP sessions in a three-pane app: a session list with one session per git worktree, an agent chat pane, and a pane for git changes, files, and a side chat.

Refract drives OMP through `omp --mode rpc-ui`, one OMP process per session, so skills, extensions, MCP servers, and slash commands keep working.

## Status

Spec 001 (core session workspace) is implemented: sessions per git worktree, chat with streaming and tool rows, approvals and questions, approval mode, restart recovery, several sessions at once, archive and delete, slash commands, and the first-run readiness check. All 49 tasks in [`specs/001-core-session-workspace/tasks.md`](specs/001-core-session-workspace/tasks.md) are done. The right pane (git changes, files, side chat) is not built yet. The transport spike is recorded in [`docs/spike/`](docs/spike/FINDINGS.md). Specs are managed with [Spec Kit](https://github.com/github/spec-kit); start with the constitution in `.specify/memory/constitution.md`.

## Prerequisites

- Windows 11.
- Node 24 or newer, with `pnpm`.
- Git for Windows.
- `omp` 18.6.3 or newer on `PATH`, signed in (`omp --version` prints `omp/18.6.3` or later). Verified against `omp/18.8.0`; 18.6.3 itself was not available to test directly (see `docs/spike/FINDINGS.md` item 49).

## Running

```
pnpm install
pnpm dev            # Tauri (Rust) build with hot reload
pnpm build          # production build (tauri build --no-bundle), output in src-tauri/target/
pnpm typecheck      # tsc --noEmit over tsconfig.node.json and tsconfig.web.json
```

`pnpm dev`/`pnpm build` run `cargo` under the hood; point `CARGO_TARGET_DIR` at a shared build
cache if disk space is tight (this repo's own worktree instructions use
`C:/Users/shopwood/.cargo-target/refract`) -- never let two worktrees build into the same
`src-tauri/target` at once without one.

`scripts/ci-local.mjs` and every `scripts/verify-*` live-check that builds Tauri or reads its
exe from the shared target directory (issue #946) refuse to run unless `CARGO_TARGET_DIR` is set
to a directory outside the repo -- they never fall back to a worktree-local `src-tauri/target`,
which has filled a worktree's disk mid-build before. A handful of live-checks (e.g.
`verify-tauri-567.mjs`) only launch a `REFRACT_*_PREBUILT_EXE` another command already built and
never read the shared target directory themselves, so this guard does not apply to them.

The shared target regrows without bound (about 19 GB in practice, enough to starve `C:`).
`pnpm cache:sweep [--days N] [--dry-run]` prunes artefacts unused for N days (default 7) with a
pinned `cargo-sweep` (installed on first use) and refuses to run while a cargo build holds the
target lock; it prints the cache size and free space before and after. `pnpm ci:local` warns when the
shared target exceeds 10 GB. `.cargo/config.toml` turns incremental compilation off for any cargo run
inside the repo, since incremental data is most of the growth (issue #1736).

There is no packaged installer yet (lane R11, issue #794). After `pnpm build`, launch the Tauri
binary directly: `src-tauri/target/release/refract-tauri.exe`.

The taskbar, Alt+Tab and notifications show the Refract logo (issue #880, PR #987: `shell::app_identity` sets `WM_SETICON`/`WM_GETICON`'s `ICON_BIG`/`ICON_SMALL` from the exe's own embedded icon and an explicit `PKEY_AppUserModel_ID`, since Tauri's own cross-platform icon API never reaches the Windows taskbar's `ICON_BIG` lookup). A `--debug` build (`pnpm tauri dev`) gets its own `.dev`-suffixed AppUserModelID, so it never shares or disturbs the installed app's taskbar identity -- but an **unpackaged `--release` build** (`pnpm build` then launching the exe directly, as above) carries the SAME AppUserModelID as the real installed app (`cfg!(debug_assertions)` is false for both), so it groups into the same taskbar button as a real running install; this is expected, not a bug. If an older taskbar entry is still pinned from before #880's fix, unpin and re-pin it once to clear Windows' icon cache.

## Where state lives

Refract keeps no state in the repo. Everything is under `%APPDATA%\refract-tauri` (`src-tauri/src/lib.rs`'s `data_dir()`, `specs/016-tauri-rust-build/spec.md` FR-014). The Rust build imports a pre-existing Electron-build `userData` directory (`%APPDATA%/pinion`, the folder keeps the app's former name, Pinion) once at startup, if present, rather than sharing it (`src-tauri/src/store/import.rs`). Tauri has no `--user-data-dir` equivalent; `scripts/verify-tauri.mjs` points a scratch instance elsewhere with the `REFRACT_DATA_DIR` environment variable instead (unset in every normal run).

| File | Holds |
|---|---|
| `registry.json` | Every Repository and Session Refract knows about (`src-tauri/src/store/registry.rs`). |
| `settings.json` | The single app-wide Settings row, currently just Approval mode (`src-tauri/src/store/settings.rs`). |
| `processes.json` | pids of live `omp` root processes, used to detect and reap orphans left by a crash (`src-tauri/src/process/pid_records.rs`). |

A Session's worktree lives next to the Repository it belongs to, not under `userData`: `<repo>/../pinion-worktrees/<repoName>/<name>` (`src-tauri/src/git/worktrees.rs`; the folder also keeps the former name).

## Verification

`pnpm verify:tauri` (issue #795) drives the Tauri/WebView2 build over the Chrome DevTools
Protocol against a scratch data directory, a scratch git repository, and a recorded-frame fake
`omp` (`scripts/verify-tauri-fake-omp.mjs`, fixtures under `scripts/fixtures/omp-frames/`) --
readiness, adding a repository, creating a Session, and a streamed chat reply, all with no model
cost and no network. `pnpm verify:tauri --real-omp` runs the readiness half of the same check
against a real, signed-in `omp` on `PATH` instead. See `scripts/fixtures/omp-frames/README.md`
for the fixture format and how to re-record them.

It builds with `tauri build --debug --no-bundle` and runs a copy of the resulting exe, never
`pnpm dev`: only one Phase R lane can hold Vite's fixed port 5174 at a time, and two lanes'
own `cargo run` processes under the shared `CARGO_TARGET_DIR` can otherwise overwrite each
other's running binary. Follow the same convention for any other live check against this build.

**Not covered (R12b, issue #795 part 3 onward):** ported Rust test cases, the transcript golden
tests, the cross-shell contract replay, generated frame types, and the performance/footprint
proof. The harness itself only ever drives `readiness` and `session`
(`scripts/fixtures/omp-frames/README.md`'s own "Scenario selection" section); `side-chat`,
`subagents`, `failure` and `exit` are fixtures for a future lane, not exercised here.

Issue #795 part 1 also asked for the Electron-era OMP skills to be updated
(`verify-refract-ui-via-cdp` and its scratch-instance variants); those are managed skill files
outside this repository (`C:/Users/shopwood/.omp/agent/managed-skills/`), so they do not appear
in this PR's diff. They were updated alongside this change to flag themselves Electron-only and
point at `pnpm verify:tauri`/`verify-refract-tauri-build-live` instead.

## Releasing

### Cutting a release

`pnpm release` is the one command that cuts a release: it bumps the version, writes
`CHANGELOG.md`, commits, tags, pushes, and publishes the signed installer, in that order. Running
it with no argument infers the bump itself (see below); `pnpm release patch`, `pnpm release
minor`, or `pnpm release major` forces that bump level instead. It refuses to run unless the
working tree is on branch `main`, is fully clean (no tracked changes, no untracked files), and
`HEAD` equals `origin/main` after a `git fetch origin`. On success, if the target version differs
from the current manifest version (always true except the very first release, which ships the
current manifest version as-is with nothing to bump), it updates the version in `package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` together (and
asserts `Cargo.lock` changed only its own `refract-tauri` version line, nothing else); prepends a
`## vX.Y.Z (YYYY-MM-DD)` section to `CHANGELOG.md`, built from GitHub's own generated release
notes for that version and grouped into "Breaking changes", "Features", "Fixes", and "Other" by
each merged PR title's conventional-commit type (a legacy, non-conventional title lands verbatim
in Other); runs `pnpm ci:local` (see below) on the edited tree; and, only if that passes, stages
and commits exactly those four version files plus `CHANGELOG.md` as `chore: release vX.Y.Z`. If
any step up to and including that commit fails -- including Ctrl+C/SIGTERM, which the script
catches specifically so the restore below always runs -- it unstages anything already added and
restores the tracked release files (never `CHANGELOG.md` is removed if it didn't exist before)
to their original, pre-release bytes (never via `git`), and reports that it did so; nothing is
committed. It exits 130 when the interrupt is the detected cause and 1 for any other failure --
an interrupt is checked (with one event-loop tick to let the signal handler actually run first)
immediately before every `git add`/`commit`/`tag`/`push` and before the publish step, so a Ctrl+C
landing in the gap between two of those steps is always caught there; the same tick-then-check
also runs again inside each of those steps' own failure handling, so a signal that kills
`cargo`/`git` directly mid-step (rather than being caught before the step even starts) is still
recognised and reported as an interrupt, not a generic failure. `git fetch origin` and
`ci:local`'s own installs/builds still happened either way -- only the tracked release files and
the git index are guaranteed back to their starting state.

Once that commit exists, a failure is handled differently, and the recovery text matches
whichever step actually failed, never a bare "just re-run pnpm release" (which cannot work once
the commit is real: `HEAD` no longer equals `origin/main`, and the manifests are already at the
new version): tagging and pushing use one atomic `git push --atomic origin main vX.Y.Z` (so
`main` and the tag either both land or neither does -- two separate pushes could let
`origin/main` move during the minutes `ci:local` takes, landing one but rejecting the other). The
script never restores file bytes or runs `git reset`/`git tag -d` once the commit is real. If
tagging is interrupted or `git tag -a` itself fails (for example a leftover local tag from an
earlier aborted attempt), the tag was never created, so the script prints the real resume
sequence to run yourself -- `git tag -a vX.Y.Z -m vX.Y.Z && git push --atomic origin main
vX.Y.Z && pnpm release:local -- --notes-from-changelog` (prefixed with `git tag -d vX.Y.Z` first
if a stale tag is the cause) -- or `git reset --keep HEAD~1` to abandon the release commit
entirely. If tagging succeeds but the atomic push is interrupted or fails, it prints the retry
(`git push --atomic origin main vX.Y.Z`, then `pnpm release:local -- --notes-from-changelog`) or
abandon (`git tag -d vX.Y.Z` then `git reset --keep HEAD~1`) commands -- and, since a Ctrl+C
during the push itself can leave the atomic push's actual outcome ambiguous, tells Stuart to
check `git ls-remote origin refs/tags/vX.Y.Z` first rather than guessing before retrying or
abandoning. After a successful push, it runs `node scripts/release-local.mjs
--notes-from-changelog` to build, sign, verify, and publish the installer, using the
`CHANGELOG.md` section it just wrote as the GitHub release's notes instead of GitHub's own
auto-generated notes. If that publish step fails (or is interrupted before it starts), the
commit, tag, and push have already happened -- it prints the exact resume command `pnpm
release:local -- --notes-from-changelog`, which finishes the release without re-doing the
version bump, changelog, commit, or push.

`pnpm release --dry-run` runs only the precondition checks (including the `git fetch origin`),
the version-inference step, a preview of the changelog section (printed to the console, never
written to `CHANGELOG.md`), and `pnpm ci:local` (see below) on the current, unmodified tree --
`ci:local`'s own installs/builds still run, but none of the tracked release files, the git index,
or any ref are written, committed, tagged, pushed, or published. It only prints the version it
would release and the changelog section preview.

Version inference, when no explicit bump is given: the last tag is the highest semver `v*` tag
reachable from `HEAD`. If there is no tag yet, the command releases the current manifest version
as-is (so the very first release is whatever version is already in the manifests, with no bump).
If there is a previous tag, it inspects every commit subject (and body, for a `BREAKING CHANGE:`
or `BREAKING-CHANGE:` footer) on `main`'s own mainline (`git log --first-parent`, so an
in-progress feature-branch commit folded into one squash merge is never walked individually)
since that tag: a `type!:` subject or a breaking footer bumps major; a `feat` subject bumps minor;
a `fix` or `perf` subject bumps patch (the type is matched case-insensitively -- `Feat:`, `FEAT:`
and `feat:` all count); every other conventional type, and every legacy, non-conventional
subject, does not bump anything. **A `BREAKING CHANGE` footer still only bumps the version --
the `CHANGELOG.md` "Breaking changes" section is built from PR TITLES only (GitHub's own
generate-notes has no PR-body/footer data to group by), so a major release can ship with an empty
or missing Breaking changes section if the breaking PR's own title didn't also use `!`.** If
nothing since the last tag would bump the version, the command stops with an error naming the
last tag and listing every un-bumping commit subject, telling the user to pass `patch`, `minor`,
or `major` explicitly instead. Passing an explicit bump level bumps from the current manifest
version, which must equal the last tag's version (or there must be no tag yet).

There is a packaged NSIS installer (lane R11d, follow-up to #794), signed locally with a
self-signed code-signing certificate Stuart created in his own `Cert:\CurrentUser\My` store:

- Subject `CN=Stuart Hopwood (Refract Code Signing)`, RSA 3072, code-signing EKU only,
  `CA:false`, SHA-1 thumbprint `31B95999D331BD33210126432FAB3FF18ECA5DBD`.
- The private key is **not exportable** and lives only on that one workstation -- CI never signs
  anything (`.github/workflows/release.yml` builds and verifies the bundle on every `v*` tag
  push, but never publishes). The public half is committed at
  `src-tauri/certs/refract-codesign.cer`; its SHA-256 is pinned in
  `src-tauri/src/updates/signature.rs`'s `SIGNING_CERT_SHA256_PINS`, which every downloaded
  update installer's signer certificate is checked against (alongside its SHA-256 checksum)
  before Refract will install it.
- The certificate is trusted only on Stuart's own machine (added to its local trusted-root/people
  store); every OTHER machine's own Windows installation reports `CERT_E_UNTRUSTEDROOT` for an
  Authenticode signature made with it. `signature.rs` accepts that one specific trust-chain
  outcome, but ONLY when the chain has no OTHER error and the signer certificate's own SHA-256
  still matches a pin -- any other outcome, any other chain error, or any pin mismatch, is
  rejected.
- **The pin is an exact byte match against the certificate's own DER, not an expiry or chain
  decision.** A signature timestamped before expiry (`/tr` at sign time) stays verifiable by
  `WinVerifyTrust` after the certificate itself expires, so **expiry alone does not invalidate
  anything already released** -- only replacing the certificate (and its pin) does.
- **Expires 2031-10-14.** `SIGNING_CERT_SHA256_PINS` is a list, not a single value, specifically
  so rotation never strands an already-installed client. The order matters:
  1. Create the new certificate (code-signing EKU, non-exportable private key) in
     `Cert:\CurrentUser\My`. Do NOT touch `certs/refract-codesign.cer` or
     `scripts/release-local.mjs`'s `CERT_THUMBPRINT` yet.
  2. Add the new certificate's SHA-256 to `SIGNING_CERT_SHA256_PINS` ALONGSIDE the current
     entry, and commit that. Releases still sign with the OLD certificate at this point.
  3. Cut one transitional release still signed with the OLD certificate (every existing install
     still trusts that pin, downloads it, and its own binary -- built from the commit in step 2
     -- now carries both pins).
  4. Only once that release has rolled out: replace `certs/refract-codesign.cer` with the new
     certificate's public half, update `CERT_THUMBPRINT` to the new thumbprint, drop the old
     pin from `SIGNING_CERT_SHA256_PINS`, trust the new certificate on Stuart's machine the same
     way the current one is trusted, and start signing with it.

`pnpm release` performs the whole cut-a-release sequence automatically: it bumps
`src-tauri/tauri.conf.json`'s `version` (together with `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/Cargo.lock`), commits, tags the commit `v<version>`, and pushes the commit and the tag
together in one atomic push, then invokes `scripts/release-local.mjs` to build, sign, verify, and
publish the installer.
`scripts/release-local.mjs` itself is otherwise unchanged from a manual release -- same signing
and verification machinery, same `--dry-run` on the local build/sign/publish portion -- except for
the new `--notes-from-changelog` flag `pnpm release` passes it, which extracts `CHANGELOG.md`'s
section for the current version and uses it as the GitHub release's notes instead of
`gh release create`'s own `--generate-notes`. Run directly (never on CI) from Stuart's own
workstation, it fails unless the working tree is clean, unless the signing certificate is present,
and unless `HEAD`'s tag matches `tauri.conf.json`'s version; builds the full NSIS bundle into a
**fresh, release-only target directory under `%TEMP%`** (never the shared dev `CARGO_TARGET_DIR`)
with a `--config` overlay that points Tauri's own `bundle.windows.signCommand` at `signtool.exe`
(located at a fixed Windows SDK path, picked by the highest version actually installed, never
`PATH`) with `/sha1 <thumbprint> /fd SHA256 /tr http://timestamp.digicert.com /td SHA256` --
Tauri's bundler then signs the main binary BEFORE NSIS packs it, and signs the generated installer
again afterwards, both in that one build (the loose build-tree `refract-tauri.exe` is never
separately re-signed: Tauri restores it to unsigned once bundling finishes, by design, and that
copy never ships); requires the installer's exact expected name
(`<productName>_<version>_x64-setup.exe`); verifies it with `Get-AuthenticodeSignature`, checking
`Status`, the signer certificate's own SHA-256 against the pin, and that a trusted timestamp is
present; if 7-Zip is installed at its fixed default path, also extracts `refract-tauri.exe` from
the signed installer and runs that same check against the embedded copy (skipped, not a failure,
if 7-Zip isn't there); writes a `.sha256` checksum sidecar for the installer; confirms `origin`'s
own tag still points at this exact commit (`git ls-remote`); then publishes the installer and its
checksum to a new GitHub release (`gh release create v<version> --verify-tag`, which refuses to
run if the tag was never pushed). The fresh target directory (build output, installer, and any
embedded-copy extraction) is deleted by its own literal path at the end of every run, published or
not -- there is no `--keep` flag; `pnpm release:local -- --dry-run` builds, signs, and verifies but
skips the publish step (and still deletes the same build output afterward).

## Where things live

| What | Where |
|---|---|
| Vocabulary | [`CONTEXT.md`](CONTEXT.md) |
| UI design system (look, feel, and interaction rules) | [`docs/design/`](docs/design/index.md) (short pointer at [`docs/DESIGN.md`](docs/DESIGN.md)) |
| Rules for building Refract | [`.specify/memory/constitution.md`](.specify/memory/constitution.md) |
| What OMP does over RPC | [`docs/spike/FINDINGS.md`](docs/spike/FINDINGS.md) |
| Feature behaviour | [`specs/`](specs/) |
| Ideas, features, and bugs | [GitHub issues](https://github.com/stuarthopwood/refract/issues) |

## Spec workflow

Run these slash commands inside OMP, in this directory:

1. `/speckit.constitution`
2. `/speckit.specify`
3. `/speckit.plan`
4. `/speckit.tasks`
5. `/speckit.implement`
6. `/speckit.converge`
