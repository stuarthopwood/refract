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
pnpm typecheck      # tsc --noEmit over the main and web projects
pnpm dev:electron   # Electron build, frozen to P0 bug fixes only (see AGENTS.md)
pnpm build:electron # Electron production build (electron-vite build), output in out/
```

`pnpm dev`/`pnpm build` run `cargo` under the hood; point `CARGO_TARGET_DIR` at a shared build
cache if disk space is tight (this repo's own worktree instructions use
`C:/Users/shopwood/.cargo-target/refract`) -- never let two worktrees build into the same
`src-tauri/target` at once without one.

There is no packaged installer yet (lane R11, issue #794). After `pnpm build`, launch the Tauri
binary directly: `src-tauri/target/release/refract-tauri.exe`. After `pnpm build:electron`, launch
the Electron build directly:

```
node_modules/electron/dist/electron.exe .
```

The taskbar, Alt+Tab and notifications show the Refract logo, not Electron's atom icon (issue #494; for a notification, this is the toast's body icon only -- the toast header still reads "Electron" until a registered Start Menu shortcut gives Windows a display name to resolve, a known limitation out of this fix's scope); if an older taskbar entry is still pinned from before this fix, unpin and re-pin it once to clear Windows' icon cache.

## Where state lives

Refract keeps no state in the repo. The Electron build's state is under its `userData` directory, which `src/main/index.ts` pins to `%APPDATA%/pinion` (the folder keeps the app's former name, Pinion, so state from before the rename carries over). `pnpm dev:electron` and `pnpm build:electron` runs share it; starting Electron with `--user-data-dir=<dir>` overrides the pin, which gives an isolated instance with its own single-instance lock. The Tauri build (`pnpm dev`/`pnpm build`, now the default per epic #797) keeps its own, separate data directory, `%APPDATA%\refract-tauri` (`src-tauri/src/lib.rs`'s `data_dir()`, `specs/016-tauri-rust-build/spec.md` FR-014), and imports the Electron state once rather than sharing it. Tauri has no `--user-data-dir` equivalent; `scripts/verify-tauri.mjs` points a scratch instance elsewhere with the `REFRACT_DATA_DIR` environment variable instead (unset in every normal run).

| File | Holds |
|---|---|
| `registry.json` | Every Repository and Session Refract knows about (`src/main/store/registry.ts`). |
| `settings.json` | The single app-wide Settings row, currently just Approval mode (`src/main/store/settings.ts`). |
| `processes.json` | pids of live `omp` root processes, used to detect and reap orphans left by a crash (`src/main/process/pidRecords.ts`). |

A Session's worktree lives next to the Repository it belongs to, not under `userData`: `<repo>/../pinion-worktrees/<repoName>/<name>` (`src/main/git/worktrees.ts`; the folder also keeps the former name).

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

There is a packaged NSIS installer (lane R11d, follow-up to #794), signed locally with a
self-signed code-signing certificate Stuart created in his own `Cert:\CurrentUser\My` store:

- Subject `CN=Stuart Hopwood (Refract Code Signing)`, RSA 3072, code-signing EKU only,
  `CA:false`, SHA-1 thumbprint `31B95999D331BD33210126432FAB3FF18ECA5DBD`.
- The private key is **not exportable** and lives only on that one workstation -- CI never signs
  anything (`.github/workflows/release.yml` builds and verifies the bundle on every `v*` tag
  push, but never publishes). The public half is committed at
  `src-tauri/certs/refract-codesign.cer`; its SHA-256 is pinned in
  `src-tauri/src/updates/signature.rs`'s `SIGNING_CERT_SHA256`, which every downloaded update
  installer is checked against (alongside its SHA-256 checksum) before Refract will install it.
- The certificate is trusted only on Stuart's own machine (added to its local trusted-root/people
  store); every OTHER machine's own Windows installation reports `CERT_E_UNTRUSTEDROOT` for an
  Authenticode signature made with it. `signature.rs` accepts that one specific trust-chain
  outcome, but ONLY when the signer certificate's own SHA-256 still matches the pin above -- any
  other outcome, or any pin mismatch, is rejected.
- **Expires 2031-10-14.** Renewing: create a new self-signed code-signing certificate in
  `Cert:\CurrentUser\My` (code-signing EKU, non-exportable private key), replace
  `src-tauri/certs/refract-codesign.cer` with its public half, recompute
  `SIGNING_CERT_SHA256` (the new certificate's own DER SHA-256) in `signature.rs`, update
  `CERT_THUMBPRINT` in `scripts/release-local.mjs`, and trust the new certificate on Stuart's
  machine the same way the current one is trusted. An installer signed with an expired or
  rotated-away certificate fails `signature.rs`'s pin check and every update install fails
  closed.

To cut a release: bump `src-tauri/tauri.conf.json`'s `version`, commit, tag the commit
`v<version>`, then run `pnpm release:local` (`scripts/release-local.mjs`) from Stuart's own
workstation. It fails unless the signing certificate is present, fails unless `HEAD`'s tag
matches `tauri.conf.json`'s version, builds the full NSIS bundle (`pnpm tauri build`), signs both
`refract-tauri.exe` and the generated installer with `signtool.exe` (located at a fixed Windows
SDK path, never `PATH`) using
`/sha1 <thumbprint> /fd SHA256 /tr http://timestamp.digicert.com /td SHA256`, verifies both with
`Get-AuthenticodeSignature`, writes a `.sha256` checksum sidecar for each, then publishes the
installer and its checksum to a new GitHub release (`gh release create v<version>`).
`pnpm release:local -- --dry-run` builds and signs but skips the publish step.

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
