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
pnpm dev          # Electron with hot reload (electron-vite dev)
pnpm build        # production build (electron-vite build), output in out/
pnpm dev:tauri    # Rust (Tauri v2) build with hot reload (epic #797; the promoted main build)
pnpm build:tauri  # production Tauri build, output in out/tauri-web/ plus the bundled installer
pnpm typecheck    # tsc --noEmit over the main and web projects
```

`dev:tauri`/`build:tauri` run `cargo` under the hood; point `CARGO_TARGET_DIR` at a shared build
cache if disk space is tight (this repo's own worktree instructions use
`C:/Users/shopwood/.cargo-target/refract`) -- never let two worktrees build into the same
`src-tauri/target` at once without one.

There is no packaged installer yet. After `pnpm build`, launch the built app directly:

```
node_modules/electron/dist/electron.exe .
```

The taskbar, Alt+Tab and notifications show the Refract logo, not Electron's atom icon (issue #494; for a notification, this is the toast's body icon only -- the toast header still reads "Electron" until a registered Start Menu shortcut gives Windows a display name to resolve, a known limitation out of this fix's scope); if an older taskbar entry is still pinned from before this fix, unpin and re-pin it once to clear Windows' icon cache.

## Where state lives

Refract keeps no state in the repo. Everything is under Electron's `userData` directory, which `src/main/index.ts` pins to `%APPDATA%/pinion` (the folder keeps the app's former name, Pinion, so state from before the rename carries over). `pnpm dev` and built runs share it; starting Electron with `--user-data-dir=<dir>` overrides the pin, which gives an isolated instance with its own single-instance lock:

| File | Holds |
|---|---|
| `registry.json` | Every Repository and Session Refract knows about (`src/main/store/registry.ts`). |
| `settings.json` | The single app-wide Settings row, currently just Approval mode (`src/main/store/settings.ts`). |
| `processes.json` | pids of live `omp` root processes, used to detect and reap orphans left by a crash (`src/main/process/pidRecords.ts`). |

A Session's worktree lives next to the Repository it belongs to, not under `userData`: `<repo>/../pinion-worktrees/<repoName>/<name>` (`src/main/git/worktrees.ts`; the folder also keeps the former name).

The Rust (Tauri v2) build keeps its own, separate data directory, `%APPDATA%/refract-tauri`
(`src-tauri/src/lib.rs`'s `data_dir()`), so the two builds never read or write each other's
`registry.json`/`settings.json` (epic #797). Tauri has no `--user-data-dir` equivalent; `scripts/
verify-tauri.mjs` points a scratch instance elsewhere with the `REFRACT_DATA_DIR` environment
variable instead (unset in every normal run).

## Verification

`pnpm verify:tauri` (issue #795) drives the Tauri/WebView2 build over the Chrome DevTools
Protocol against a scratch data directory, a scratch git repository, and a recorded-frame fake
`omp` (`scripts/verify-tauri-fake-omp.mjs`, fixtures under `scripts/fixtures/omp-frames/`) --
readiness, adding a repository, creating a Session, and a streamed chat reply, all with no model
cost and no network. `pnpm verify:tauri --real-omp` runs the readiness half of the same check
against a real, signed-in `omp` on `PATH` instead. See `scripts/fixtures/omp-frames/README.md`
for the fixture format and how to re-record them.

It builds with `tauri build --debug --no-bundle` and runs a copy of the resulting exe, never
`pnpm dev:tauri`: only one Phase R lane can hold Vite's fixed port 5174 at a time, and two lanes'
own `cargo run` processes under the shared `CARGO_TARGET_DIR` can otherwise overwrite each
other's running binary. Follow the same convention for any other live check against this build.

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
