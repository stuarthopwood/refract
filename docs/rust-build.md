# Rust build and live verification

Moved from AGENTS.md to keep agent startup context small. AGENTS.md keeps the summary rules.

## Rust build is the main build (Stuart, 2026-10-13, epic #797)

The Tauri v2 Rust build (`src-tauri/`) is Refract's only build; the Electron build (`src/main`,
`src/preload`, electron-vite) was deleted (issue #796). `src/renderer` and `src/shared` continue
normally.

- Build, test and gate commands: `pnpm typecheck`, `pnpm test`, `pnpm check:indent`,
  `check:ui-text`, `check:theme-contrast`, `check:drag-regions`, `check:file-size`, `check:comment-density`, and `pnpm
  check:parity` (generated IPC parity table, `src/shared/ipc.ts` against `src-tauri/src`).
  For `src-tauri/`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
  (run with `--manifest-path src-tauri/Cargo.toml` from the repository root, or `cd src-tauri`
  first). `pnpm ci:local` (`.github/ci-local.yml`) runs all of these and is the merge gate. GitHub
  Actions runs only the fast tier (`.github/workflows/pr-fast.yml`) on every pull request to `main`:
  `pnpm typecheck`, `pnpm test`, and the `check:*` steps that need no cargo, Windows, or built
  bundle, on `ubuntu-latest`. It has no cargo, no Windows runner, no push trigger and no nightly
  run, because the full Windows suite used up the Actions minutes (2026-10-14). Run the same fast
  tier locally with `pnpm test:fast`; see `docs/development/test-strategy.md`.
  `check:mermaid-contrast` is NOT in that list: it already had known failures tracked in #388,
  and since #796 (the Electron build deleted) it can no longer run at all -- it `require('electron')`s
  a real Electron renderer to capture Mermaid diagram colours, and there is no `electron` package
  left in this repo to load. The script and its `check:mermaid-contrast` npm command stay
  (an obvious entry point once someone picks this up), but need a Tauri/WebView2-based capture
  rework, not just the pre-existing fixes, before it can run or join CI; see #388.
- Security baseline for the Rust build: constitution Principle V ("Tauri Security Baseline",
  ratified 3.0.0, 2026-10-15, #796) is binding. `specs/016-tauri-rust-build/
  constitution-amendment-draft.md` is the superseded pre-ratification draft, kept for history
  only.
- Per-lane Rust file ownership (which lane owns which `src-tauri/src/**` module, so no two lanes
  touch the same file) lives in `docs/PLAN.md`'s Phase R table, not duplicated here.

## Verifying the Rust (Tauri) build (epic #797)

The Rust build has its own shared build cache and its own live-verification mechanics, ported
from the former Electron CDP skill (`scripts/verify-tauri-cdp.mjs`).

- Point `CARGO_TARGET_DIR` at the shared, already-populated cache for every `cargo`/`tauri`
  command (disk space is tight); never let `src-tauri/target` get created inside a worktree.
  Builds serialise on that cache's lock -- wait for a build in flight rather than starting a
  second one, and never delete anything under the shared cache except a crate-scoped `cargo
  clean -p <crate>` for a confirmed stale-path error (`pnpm worktrees:reap --apply` runs
  `cargo clean -p refract-tauri` itself, after a reap, when the build-script output names a reaped or
  deleted worktree, and only while no `cargo.exe`/`rustc.exe` is running; #1734), or `pnpm cache:sweep` (`scripts/cache-sweep.mjs`,
  #1736): a pinned `cargo-sweep` that removes only artefacts unused for N days (default 7,
  `--days N`; `--dry-run` previews), and refuses while any cargo build holds a target lock (Windows only: Linux/macOS cargo locks are advisory and not detected).
  `pnpm ci:local` warns when the cache passes 10 GB. `.cargo/config.toml` turns incremental
  compilation off for every cargo run whose working directory is inside the repo, because
  incremental data was about 6.5 GB of a 14.8 GB cache. Set `CARGO_INCREMENTAL=1` to opt back in
  for one run. `[profile.dev]` in `src-tauri/Cargo.toml` sets `debug = "line-tables-only"`, which
  keeps file and line numbers in backtraces but drops variable-level debug info, so a debugger
  cannot inspect locals. Neither setting removes existing artefacts; after changing them, run
  `pnpm cache:sweep` to drop the stale incremental data and the old full-debug dev build.
- `scripts/verify-tauri.mjs` (`pnpm verify:tauri`, issue #795) is the CDP harness: a scratch data
  directory (`REFRACT_DATA_DIR`, debug builds only, since Tauri has no `--user-data-dir`
  equivalent), a scratch git repository, and a recorded-frame fake `omp` on PATH ahead of the
  real one, so a UI flow can be driven with no model cost and no network. Only `readiness` (US1)
  and `session` (US4) are ever driven this way; `side-chat`/`subagents`/`failure`/`exit` are
  fixtures for a lane to select directly once it ports the matching channel
  (`scripts/fixtures/omp-frames/README.md`). Use the harness instead of a live real-`omp` CDP
  session wherever the flow you need is already covered; fall back to a real `omp` only for a
  flow the fixtures do not cover yet. **Not covered by this harness (R12b, #795 part 3 onward):**
  ported Rust test cases, transcript golden tests, the cross-shell contract replay, generated
  frame types, the performance/footprint proof.
- **Never `pnpm dev` for a live check (2026-10-13 live-run convention).** It holds Vite's
  fixed port 5174, and the running exe lives under the shared `CARGO_TARGET_DIR`, so two lanes'
  own dev servers or running binaries collide. Instead: `pnpm exec tauri build --debug --no-bundle`
  (bakes the renderer in, no dev server, no port), copy
  `<CARGO_TARGET_DIR>/debug/refract-tauri.exe` to `%TEMP%\scratch\<task>\` (one folder per task; see
  `AGENTS.md`), and run that copy with
  your own `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` and
  `REFRACT_DATA_DIR` pointing at a data directory under `%TEMP%\scratch\<task>\`, never Stuart's real
  `%APPDATA%\refract-tauri`. `scripts/verify-tauri.mjs` already does this.
- `REFRACT_OMP_SESSIONS_DIR` (spec 060, #1331) is an absolute path that
  replaces `~/.omp/agent/sessions` as the folder the Usage worker reads, so a live check can feed
  it a synthetic fixture. A relative or empty value is ignored. `scripts/verify-tauri-1331.mjs`
  (`node scripts/verify-tauri-1331.mjs`, with `CARGO_TARGET_DIR` and `SHOTS_DIR` set) uses it with
  a fake `omp` and a fake `gh` on PATH and proves both through their call logs.

## Rust test isolation and link locks (#1733, #1980)

- Tests run the real git, so every test-spawned git gets `GIT_CONFIG_GLOBAL=/dev/null` and
  `GIT_CONFIG_NOSYSTEM=1` (`test_scratch::GIT_ISOLATION_ENV`): production `build_git_command` adds them under
  `cfg(test)`, and the three test `run_git` helpers (`git/test_support.rs`, `git/remote.rs`,
  `ipc/repositories_tests.rs`) use the same constant. A new test helper that spawns git must do the same.
- A test whose outcome must not depend on load passes its own bound instead of the production
  constant: `delete_check_for_session_within` takes the timeout, and `delete_check_for_session` passes
  `READER_TIMEOUT` (15 s, unchanged). Never lengthen a test by sleeping.
- `LNK1105` / OS error 1224 on `refract_tauri-*.exe` means the linker cannot replace an exe that a
  process still maps. Cargo's target lock covers only a build, not the test run that follows, so a
  `cargo test` still running (or hung) in the same target can hold the exe while the next build links
  it. `pnpm ci:local` now warns, before any step, naming each exe under `<CARGO_TARGET_DIR>/debug/deps`
  that a process still holds; end that run by PID (never by image name). Antivirus real-time scans
  of the target folder can hold a freshly linked exe the same way and are outside the repo's control:
  exclude the shared `CARGO_TARGET_DIR` from real-time scanning if the error persists with no run in flight.
