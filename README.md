# Refract

A desktop harness for [OMP (oh-my-pi)](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent). Refract hosts OMP sessions in a three-pane app: a session list with one session per git worktree, an agent chat pane, and a pane for git changes, files, and a side chat.

Refract drives OMP through `omp --mode rpc-ui`, one OMP process per session, so skills, extensions, MCP servers, and slash commands keep working.

## Status

Spec 001 (core session workspace) is implemented: sessions per git worktree, chat with streaming and tool rows, approvals and questions, approval mode, restart recovery, several sessions at once, archive and delete, slash commands, and the first-run readiness check. All 49 tasks in [`specs/001-core-session-workspace/tasks.md`](specs/001-core-session-workspace/tasks.md) are done. The right pane (git changes, files, side chat) is not built yet. Spec 006 (installer and updates) has its packaging, dependency-install, update-check, and release-publish code in place, but its live install/uninstall/update gates (`specs/006-installer-and-updates/tasks.md` Phase 1, T001 to T005, and the install-then-uninstall checks) have not yet been run on a real machine; see the "Unverified" notes below. The transport spike is recorded in [`docs/spike/`](docs/spike/FINDINGS.md). Specs are managed with [Spec Kit](https://github.com/github/spec-kit); start with the constitution in `.specify/memory/constitution.md`.

## Prerequisites

- Windows 11.
- Node 24 or newer, with `pnpm`.
- Git for Windows.
- `omp` 18.4.x or 18.5.x on `PATH`, signed in (`omp --version` prints `omp/18.4.x` or `omp/18.5.x`).
- The GitHub CLI (`gh`), signed in, is optional: Refract's first-run readiness screen marks it as
  an optional item, used only for checking and installing updates and for the pull request view
  (spec 003). Nothing else in Refract needs it.

## Running

```
pnpm install
pnpm dev          # Electron with hot reload (electron-vite dev)
pnpm build        # production build (electron-vite build), output in out/
pnpm typecheck    # tsc --noEmit over the main and web projects
pnpm package      # electron-builder --win; builds the Windows installer, output in release/
```

`pnpm package` needs a prior `pnpm build`. It produces one `.exe` under `release/` (for example
`release/Refract Setup 0.1.0.exe`): a per-user, no-admin NSIS installer that adds a Desktop
shortcut and a Start Menu entry, registers in Windows Settings > Apps with its version, and
upgrades an existing install in place without touching `%APPDATA%/pinion` (see "Where state
lives" below). The packaging config lives in `electron-builder.yml` and `build/installer.nsh`;
see [`specs/006-installer-and-updates/`](specs/006-installer-and-updates/) for the design behind
it.

Until the installer is verified end to end, you can also launch a `pnpm build` output directly
without packaging it:

```
node_modules/electron/dist/electron.exe .
```

**Unverified**: the no-admin install, the in-place upgrade, and the shortcuts above are this
spec's own design (`research.md` decisions 1-2) and have not yet been confirmed by actually
running the built installer; see "Installing missing dependencies", "Checking for updates", and
"Uninstalling" below for the same caveat on their own open gates
(`specs/006-installer-and-updates/tasks.md` Phase 1, T001 to T005).

## Installing missing dependencies

On first launch, if Git, OMP, or the GitHub CLI (optional) is missing, the first-run readiness
screen offers an Install action next to the missing item: selecting it downloads that
dependency's own official installer and runs it unattended, shows progress, then re-checks the
item automatically. OMP's Install action always targets the supported `18.4.x`/`18.5.x` line,
never whatever is newest. The GitHub CLI's own sign-in (`gh auth login`) and OMP's own sign-in
(`omp login`) are never done for you; the readiness screen still points you at them by hand.

**Unverified**: whether Git for Windows' and the GitHub CLI's own installers actually run
unattended without an administrator prompt, and whether OMP's pinned-version install script
installs a version `omp --version` immediately reports as supported (gates T001, T002). If a
dependency's own installer needs elevation, Windows itself may still prompt for it; Refract
itself never requests administrator rights.

## Checking for updates

Refract checks for a newer private GitHub Release automatically at startup and on demand from the
status bar's update badge, using your own signed-in `gh` CLI (no token is stored by Refract, same
stance as the pull request view, spec 003). Selecting Update downloads the new installer, verifies
it against its published checksum, and holds it ready; it installs itself only the next time you
quit Refract normally, never interrupting a running agent or turn. If the GitHub CLI is missing,
signed out, or the machine is offline, the check says so in plain words instead of showing an
error.

**Unverified**: whether `gh release download`/`gh release view` actually work against this
private repository's releases while signed in, and whether `gh auth status` reliably
distinguishes not-installed, signed-out, and offline (gate T005).

## Uninstalling

Uninstall from Windows Settings > Apps, or from Refract's Start Menu folder's uninstall entry.
Uninstalling asks whether to also delete Refract's own settings and session list
(`%APPDATA%/pinion`); the default is to keep them. Either way, Git, OMP, the GitHub CLI, your
repositories, worktrees, and OMP conversations are left untouched. If Refract is running, the
uninstaller asks you to close it first.

**Unverified**: whether the keep/delete-data prompt and the close-Refract-first guard actually
fire, interactively and under a silent uninstall (gate T004); the install-then-uninstall live
check itself has not been run either.

## Cutting a release (maintainer)

Bump `package.json`'s `version`, commit, then push a matching `vX.Y.Z` tag (add a `-rc`, `-beta`,
or `-alpha` suffix for a pre-release). `.github/workflows/release.yml` builds and publishes a
private GitHub Release carrying the installer and its `.sha256` checksum file, with generated
release notes. A tag whose numeric part does not match `package.json`'s version fails the
workflow's guard step rather than publishing a mismatched release. A release missing its
installer or checksum asset, or left as a draft or pre-release, is never offered to anyone as an
update.

**Unverified**: this workflow has not yet been exercised against a real pushed tag.

## Where state lives

Refract keeps no state in the repo. Everything is under Electron's `userData` directory, which `src/main/index.ts` pins to `%APPDATA%/pinion` (the folder keeps the app's former name, Pinion, so state from before the rename carries over). `pnpm dev` and built runs share it; starting Electron with `--user-data-dir=<dir>` overrides the pin, which gives an isolated instance with its own single-instance lock:

| File | Holds |
|---|---|
| `registry.json` | Every Repository and Session Refract knows about (`src/main/store/registry.ts`). |
| `settings.json` | The single app-wide Settings row, currently just Approval mode (`src/main/store/settings.ts`). |
| `processes.json` | pids of live `omp` root processes, used to detect and reap orphans left by a crash (`src/main/process/pidRecords.ts`). |

A Session's worktree lives next to the Repository it belongs to, not under `userData`: `<repo>/../pinion-worktrees/<repoName>/<name>` (`src/main/git/worktrees.ts`; the folder also keeps the former name).

## Where things live

| What | Where |
|---|---|
| Vocabulary | [`CONTEXT.md`](CONTEXT.md) |
| Look, feel, and interaction rules | [`docs/DESIGN.md`](docs/DESIGN.md) |
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
