#!/usr/bin/env node
// `node scripts/measure-footprint.mjs` (issue #795 part 5, R12b): print-a-number tool comparing
// the Rust (Tauri/WebView2) RELEASE build's process-tree private memory against the Electron
// build's existing production bundle -- a release-vs-release comparison, not an unoptimised debug
// build vs a production one. Each shell runs the exact same recorded-frame `session` fixture
// scenario (scripts/fixtures/omp-frames/session.jsonl via scripts/verify-tauri-fake-omp.mjs)
// MEASURE_REPEAT_COUNT times (fresh process launch each time): window up, one repository added,
// one Session created, one streamed chat turn with a tool-call approval, settled, measured, torn
// down -- so the reported numbers are a median and a min-max range across repeated samples, not a
// single noisy snapshot (process counts are known to vary run to run).
//
// Per an explicit 2026-10-14 decision (relayed by the lane's parent): footprint is INFORMATION,
// never a gate. This script only measures and prints; it is NOT wired into `pnpm test` or any CI
// script, asserts no pass/fail threshold, and nothing else in this lane does either. Numbers are
// machine-dependent (CPU, WebView2/Chromium version, antivirus, background load) -- re-run on the
// machine you care about rather than trusting a number recorded elsewhere.
//
// Measurement method: Win32 has no single "total memory of a process tree" API, so this walks it
// in two PowerShell calls per app (see `./measure-footprint-helpers.mjs`'s `getAllProcesses`/
// `collectTreePids`/`measurePrivateMemory`/`measureProcessTree` for the full mechanism): a
// `Win32_Process` snapshot, a breadth-first walk from the launched root pid, then a
// `PrivateMemorySize64` sum over every pid in that tree. Two totals are reported per shell, per
// run: the FULL process tree, and an APP-ONLY subtotal that excludes the fake-omp test harness's
// own overhead (`node` running the fake-omp script, the compiled `omp` PATH-shim exe, and the
// `conhost` console-host helper) -- harness processes that exist only because this measurement
// tool drives a scripted scenario, not because the app itself spawned them as part of its normal
// footprint. Private memory is used throughout: it is the COMMITTED memory actually attributable
// to the process alone (not shared with other processes) -- NOT working set, and NOT memory that
// "can't be paged out": private/committed memory can absolutely still be paged to disk by the OS;
// "private" here means "not shared with another process", nothing more.
//
// RELEASE BUILD DATA-DIR ISOLATION (the hard part of this script): `data_dir()`
// (src-tauri/src/lib.rs) only honours the `REFRACT_DATA_DIR` scratch override under
// `#[cfg(debug_assertions)]` -- a deliberate, documented security requirement ("a packaged release
// build must never honour an env var that redirects where it reads/writes session data"). A plain
// release build therefore always reads/writes the REAL `%APPDATA%\refract-tauri` profile, with no
// Rust-side flag to redirect it. This script tries two ways to still measure an optimised build
// without ever touching that real profile, in this order, and PROVES isolation before trusting
// either one rather than assuming it works:
//   1. PREFERRED: an unmodified release build, launched with `APPDATA`/`LOCALAPPDATA` pointed at a
//      scratch tree. `verifyAppDataEnvRedirect` launches it once first, with no UI interaction,
//      and compares a before/after snapshot (mtime + sha256 of every file) of the REAL profile
//      directory, plus whether the scratch tree actually received the app's own data. The `dirs`
//      crate resolves this via `SHGetKnownFolderPath`, which is known not to honour a redirected
//      `APPDATA` env var on an ordinary Windows profile (see `data_dir()`'s own doc comment) -- so
//      this is genuinely expected to fail on most machines, and the check exists to catch exactly
//      that rather than silently trust it.
//   2. FALLBACK (only if 1 does not prove isolation, and no real file changed): a release-PROFILE
//      build with `CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true` /
//      `CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=false` -- `#[cfg(debug_assertions)]` is controlled by
//      the compiler's `-C debug-assertions` flag, which this env var overrides independent of
//      optimisation level, so `REFRACT_DATA_DIR` works exactly as it does for a `--debug` build
//      while keeping release-level optimisations. Labelled everywhere as "optimised build with
//      debug assertions: not production-equivalent" -- a close approximation, not the real thing.
// If verification ever shows a REAL file changed, this script stops immediately rather than
// falling through to (2) or retrying -- a confirmed write into a real profile needs a human to
// look at it, not an automatic recovery.
//
// Process lifecycle: both apps are launched exactly like `scripts/verify-tauri.mjs` already does
// for the Rust build -- inside `scripts/verify-tauri-launcher.rs`'s own kill-on-close Win32 Job
// Object (`scripts/verify-tauri-cdp.mjs`'s `launchViaJobObject`/`stopLauncher`, imported and reused
// unchanged here, not duplicated), so tearing either one down is a single OS-level job
// termination, never a `taskkill` of a computed pid. The Rust side's own RELEASE build output
// under the shared `CARGO_TARGET_DIR/release/` is deleted by its own literal absolute path once
// this script is done measuring (see `main`'s own `finally`), same shared-disk cleanliness
// convention every Phase R lane's build step honours.
//
// `scripts/verify-tauri.mjs`'s own build/copy helpers are not exported there (it is a self-running
// CLI script, not a module), so a few are reproduced in `./measure-footprint-helpers.mjs` rather
// than editing that file (owned by R12a/#795 part 1, already landed in PR #820) to add exports.
// Every generic helper (build, CDP-driven scripted flow, process-tree measurement, run-summary)
// lives in that sibling file solely to keep both files under the 600-line soft cap (issue #806);
// this file keeps the parts unique to this tool: the two isolation-proof functions, the per-shell
// orchestration (which decides option 1 vs option 2 for Rust), and `main`.

import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';
import {
  RELEASE_OUTPUT_DIR,
  safeRmSync,
  snapshotDir,
  snapshotsEqual,
  buildOmpShim,
  buildLauncher,
  makeScratchRepo,
  worktreesDirFor,
  buildTauriRelease,
  copyBuiltExe,
  buildElectron,
  resolveElectronBinary,
  waitForReadinessGreen,
  openSessionAndSendMessage,
  measureProcessTree,
  logTree,
  mib,
  summarizeRuns,
} from './measure-footprint-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same prompt/token pair verify-tauri.mjs uses for US4: independent strings, so a check against
// the reply token can never pass merely because the echoed prompt happens to contain it.
const PROMPT_MESSAGE = 'Please respond now.';
const REPLY_TOKEN = 'xyzzy9';
// Generous pause after the streamed reply finishes so any post-turn GC/idle-compaction in either
// runtime has a chance to settle before the snapshot -- not a correctness wait (the tool-call
// approval and streamed reply are already awaited to completion above it), just measurement
// hygiene so the number reflects steady state rather than a mid-turn allocation spike.
const SETTLE_DELAY_MS = 3000;
// How many fresh-launch samples to take per shell: one snapshot is noise (process counts are
// known to vary run to run), so this reports a median and a min-max range instead.
const MEASURE_REPEAT_COUNT = 5;
// The REAL, non-scratch profile a release build reads/writes (see the module doc comment above).
// This script must NEVER let a release-mode launch mutate this directory without first proving a
// redirect actually works.
const REAL_TAURI_DATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'refract-tauri') : path.join(homedir(), 'AppData', 'Roaming', 'refract-tauri');

/** Launches the just-built release exe ONCE with `APPDATA`/`LOCALAPPDATA` pointed at a scratch
 * tree (plus the usual WebView2 user-data redirect, which is a separate, always-effective
 * mechanism -- see module doc comment), does NOT touch the UI at all (no onboarding, no
 * repository, no session: any click here would be a scripted action against whatever profile the
 * app actually resolved, real or scratch, and this step runs BEFORE that is known to be safe), and
 * compares a before/after snapshot of the REAL `REAL_TAURI_DATA_DIR`. Returns
 * `{ realUnchanged, scratchReceivedData }`; throws immediately (caught by `main`, which must NOT
 * attempt any further release-mode launch after that) if the real profile changed at all. */
async function verifyAppDataEnvRedirect({ shimDir, launcherExe, exePath }) {
  const scratchAppData = mkdtempSync(path.join(tmpdir(), 'refract-footprint-appdata-probe-'));
  const scratchLocalAppData = mkdtempSync(path.join(tmpdir(), 'refract-footprint-localappdata-probe-'));
  const webview2DataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-wv2-probe-'));
  const before = snapshotDir(REAL_TAURI_DATA_DIR);
  let launcherChild, cdp;
  try {
    const port = await getFreePort();
    const pidFile = path.join(webview2DataDir, 'target.pid');
    const env = {
      ...process.env,
      APPDATA: scratchAppData,
      LOCALAPPDATA: scratchLocalAppData,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      PATH: `${shimDir};${process.env.PATH}`,
    };
    console.log(`measure-footprint: [rust] isolation check: launching once with APPDATA=${scratchAppData}, LOCALAPPDATA=${scratchLocalAppData} (no UI interaction)...`);
    const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
    launcherChild = launched.child;
    const targetPid = launched.targetPid;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`measure-footprint: [rust] isolation check: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
    }
    // No UI polling: whether the readiness screen appears depends on which profile the app
    // actually resolved (scratch = empty = onboarding shows; real = already has data = it does
    // not), which is itself part of what this check is trying to determine -- so a flat settle
    // delay only, long enough for the app's own startup data_dir read/write to complete.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } finally {
    cdp?.close();
    if (launcherChild) await stopLauncher(launcherChild);
  }
  const after = snapshotDir(REAL_TAURI_DATA_DIR);
  const realUnchanged = snapshotsEqual(before, after);
  const scratchAppDataTauriDir = path.join(scratchAppData, 'refract-tauri');
  const scratchReceivedData = existsSync(scratchAppDataTauriDir) && readdirSync(scratchAppDataTauriDir).length > 0;
  await safeRmSync(scratchAppData);
  await safeRmSync(scratchLocalAppData);
  await safeRmSync(webview2DataDir);
  if (!realUnchanged) {
    throw new Error(
      `ISOLATION_CHECK_FAILED_REAL_PROFILE_CHANGED: verifyAppDataEnvRedirect detected a change in the REAL ${REAL_TAURI_DATA_DIR} ` +
        `between before/after snapshots while APPDATA/LOCALAPPDATA were redirected to scratch dirs -- the env-var redirect did NOT ` +
        `take effect on this build, and the real profile was written to. STOPPING: no further release-mode launch will run.`,
    );
  }
  console.log(
    `measure-footprint: [rust] isolation check result: real profile unchanged (${Object.keys(before).length} file(s) checked) / ` +
      `scratch tree ${scratchReceivedData ? 'DID' : 'did NOT'} receive the app's own data`,
  );
  return { realUnchanged, scratchReceivedData };
}

/** Same proof as `verifyAppDataEnvRedirect`, for option 2: launches the debug-assertions release
 * exe ONCE with `REFRACT_DATA_DIR` (plus the usual WebView2 user-data redirect) pointed at a
 * scratch dir, no UI interaction, and compares a before/after snapshot of the REAL
 * `REAL_TAURI_DATA_DIR`. `REFRACT_DATA_DIR` is the existing, long-proven mechanism `verify-
 * tauri.mjs` has used since R12a for the debug build -- but this is a different binary (release
 * profile, debug-assertions forced on via env var rather than the dev profile's own default), so
 * it is re-proven here rather than assumed. Throws immediately if the real profile changed at
 * all; never falls through silently. */
async function verifyRefractDataDirRedirect({ shimDir, launcherExe, exePath }) {
  const scratchDataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-data-probe-'));
  const webview2DataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-wv2-probe-'));
  const before = snapshotDir(REAL_TAURI_DATA_DIR);
  let launcherChild, cdp;
  try {
    const port = await getFreePort();
    const pidFile = path.join(webview2DataDir, 'target.pid');
    const env = {
      ...process.env,
      REFRACT_DATA_DIR: scratchDataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      PATH: `${shimDir};${process.env.PATH}`,
    };
    console.log(`measure-footprint: [rust] option 2 isolation check: launching once with REFRACT_DATA_DIR=${scratchDataDir} (no UI interaction)...`);
    const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
    launcherChild = launched.child;
    const targetPid = launched.targetPid;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`measure-footprint: [rust] option 2 isolation check: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } finally {
    cdp?.close();
    if (launcherChild) await stopLauncher(launcherChild);
  }
  const after = snapshotDir(REAL_TAURI_DATA_DIR);
  const realUnchanged = snapshotsEqual(before, after);
  const scratchReceivedData = existsSync(scratchDataDir) && readdirSync(scratchDataDir).length > 0;
  await safeRmSync(scratchDataDir);
  await safeRmSync(webview2DataDir);
  if (!realUnchanged) {
    throw new Error(
      `ISOLATION_CHECK_FAILED_REAL_PROFILE_CHANGED: verifyRefractDataDirRedirect (option 2) detected a change in the REAL ${REAL_TAURI_DATA_DIR} ` +
        `between before/after snapshots while REFRACT_DATA_DIR was redirected to a scratch dir. STOPPING: no further release-mode launch will run.`,
    );
  }
  console.log(
    `measure-footprint: [rust] option 2 isolation check result: real profile unchanged (${Object.keys(before).length} file(s) checked) / ` +
      `scratch dir ${scratchReceivedData ? 'DID' : 'did NOT'} receive the app's own data`,
  );
  return { realUnchanged, scratchReceivedData };
}

/** Builds the release exe ONCE, proves (or disproves) the APPDATA/LOCALAPPDATA env-var redirect
 * (option 1), falls back to a debug-assertions release rebuild (option 2) if option 1 does not
 * prove isolation, then drives `MEASURE_REPEAT_COUNT` fresh launches of whichever build ended up
 * verified-safe. Returns `{ mode, label, runs }`. */
async function measureRustApp() {
  let shimDir, exeDir;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-shim-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-exe-'));
    console.log(`measure-footprint: [rust] shim dir ${shimDir}, exe dir ${exeDir}`);
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);

    console.log('measure-footprint: [rust] building (tauri build --no-bundle, RELEASE, unmodified -- option 1, no dev server)...');
    buildTauriRelease({ debugAssertions: false });
    let exePath = copyBuiltExe(exeDir);
    console.log(`measure-footprint: [rust] built release exe copied to ${exePath}`);

    let mode, label;
    try {
      const { scratchReceivedData } = await verifyAppDataEnvRedirect({ shimDir, launcherExe, exePath });
      if (scratchReceivedData) {
        mode = 'release-env-redirect';
        label = 'Rust (Tauri, release, APPDATA/LOCALAPPDATA redirect verified isolated)';
        console.log('measure-footprint: [rust] option 1 (unmodified release + env redirect) VERIFIED isolated -- using it.');
      } else {
        console.log(
          'measure-footprint: [rust] option 1 did NOT prove isolation (real profile unchanged, but the scratch tree received no data -- ' +
            'the APPDATA/LOCALAPPDATA redirect had no effect on this build).',
        );
      }
    } catch (err) {
      if (!String(err.message).startsWith('ISOLATION_CHECK_FAILED_REAL_PROFILE_CHANGED')) throw err;
      // Option 1 touched the real profile (confirmed, this session: only `updateState.json`,
      // never `registry.json`/`profileCache.json`, across every real-profile launch so far --
      // consistent with a background update-check write, not session data). Falling through to
      // option 2 here, rather than hard-stopping, is an explicit human sign-off (relayed by the
      // lane's parent, 2026-10-14, after reviewing exactly this failure) -- not a silent
      // auto-recovery from an unreviewed real-data write.
      console.warn(`measure-footprint: [rust] option 1 isolation check FAILED: ${err.message}`);
      console.warn(
        'measure-footprint: [rust] falling through to option 2 per explicit human sign-off after reviewing this exact failure ' +
          '(confirmed: only updateState.json changed, never registry.json/profileCache.json).',
      );
    }
    if (!mode) {
      mode = 'release-debug-assertions';
      label = 'Rust (Tauri, optimised build with debug assertions: NOT production-equivalent)';
      console.log(
        'measure-footprint: [rust] option 2: rebuilding with CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true/' +
          'CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=false so REFRACT_DATA_DIR is honoured (release optimisation level unchanged)...',
      );
      buildTauriRelease({ debugAssertions: true });
      exePath = copyBuiltExe(exeDir);
      console.log(`measure-footprint: [rust] option 2 build copied to ${exePath}`);
      await verifyRefractDataDirRedirect({ shimDir, launcherExe, exePath });
      console.log(`measure-footprint: [rust] option 2 isolation check VERIFIED isolated -- proceeding with ${MEASURE_REPEAT_COUNT} measurement runs.`);
    }

    const results = [];
    for (let run = 1; run <= MEASURE_REPEAT_COUNT; run++) {
      let dataDir, appDataDir, localAppDataDir, repoDir, webview2DataDir, launcherChild, cdp;
      try {
        repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-repo-')));
        webview2DataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-wv2-'));
        const port = await getFreePort();
        const pidFile = path.join(webview2DataDir, 'target.pid');
        const env = {
          ...process.env,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
          WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
          REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
          REFRACT_FAKE_OMP_NODE: process.execPath,
          PATH: `${shimDir};${process.env.PATH}`,
        };
        if (mode === 'release-env-redirect') {
          appDataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-appdata-'));
          localAppDataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-localappdata-'));
          env.APPDATA = appDataDir;
          env.LOCALAPPDATA = localAppDataDir;
        } else {
          dataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-data-'));
          env.REFRACT_DATA_DIR = dataDir;
        }
        console.log(`measure-footprint: [rust] run ${run}/${MEASURE_REPEAT_COUNT}: repo dir ${repoDir}, CDP port ${port}`);

        const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
        launcherChild = launched.child;
        const targetPid = launched.targetPid;
        console.log(`measure-footprint: [rust] run ${run}: launched, target pid ${targetPid}`);

        const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
        cdp = await CdpSession.connect(wsUrl);
        if (!isTargetOwningPort(port, targetPid)) {
          throw new Error(`measure-footprint: [rust] run ${run}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
        }
        await waitForReadinessGreen(cdp);
        await openSessionAndSendMessage(cdp, { repoDir, message: PROMPT_MESSAGE, finalToken: REPLY_TOKEN });
        console.log(`measure-footprint: [rust] run ${run}: session settled; waiting ${SETTLE_DELAY_MS}ms before measuring...`);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));

        results.push(measureProcessTree(targetPid));
      } finally {
        cdp?.close();
        if (launcherChild) await stopLauncher(launcherChild);
        await safeRmSync(dataDir);
        await safeRmSync(appDataDir);
        await safeRmSync(localAppDataDir);
        await safeRmSync(webview2DataDir);
        if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
        await safeRmSync(repoDir);
      }
    }
    return { mode, label, runs: results };
  } finally {
    await safeRmSync(shimDir);
    await safeRmSync(exeDir);
  }
}

/** Builds Electron's production bundle and resolves its binary ONCE, then drives
 * `MEASURE_REPEAT_COUNT` fresh launches -- same convention as `measureRustApp`. */
async function measureElectronApp() {
  let shimDir;
  const results = [];
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-electron-shim-'));
    console.log(`measure-footprint: [electron] shim dir ${shimDir}`);
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);

    console.log('measure-footprint: [electron] building (pnpm build:electron)...');
    buildElectron();
    const electronExe = resolveElectronBinary();
    console.log(`measure-footprint: [electron] binary ${electronExe}`);

    for (let run = 1; run <= MEASURE_REPEAT_COUNT; run++) {
      let userDataDir, repoDir, launcherChild, cdp;
      try {
        userDataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-electron-data-'));
        repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-footprint-electron-repo-')));
        const port = await getFreePort();
        console.log(`measure-footprint: [electron] run ${run}/${MEASURE_REPEAT_COUNT}: user-data dir ${userDataDir}, repo dir ${repoDir}, CDP port ${port}`);

        const pidFile = path.join(userDataDir, 'target.pid');
        const env = {
          ...process.env,
          REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
          REFRACT_FAKE_OMP_NODE: process.execPath,
          PATH: `${shimDir};${process.env.PATH}`,
        };
        // Same pattern the verify-refract-ui-via-cdp skill documents for an isolated Electron
        // instance: `.` (resolved relative to `cwd` below) as the app-source argument,
        // `--user-data-dir` for a scratch profile, `--remote-debugging-port` for CDP.
        const args = ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`];
        const launched = await launchViaJobObject(launcherExe, pidFile, electronExe, args, { cwd: path.resolve(__dirname, '..'), env });
        launcherChild = launched.child;
        const targetPid = launched.targetPid;
        console.log(`measure-footprint: [electron] run ${run}: launched, target pid ${targetPid}`);

        const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
        cdp = await CdpSession.connect(wsUrl);
        if (!isTargetOwningPort(port, targetPid)) {
          throw new Error(`measure-footprint: [electron] run ${run}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
        }
        await waitForReadinessGreen(cdp);
        await openSessionAndSendMessage(cdp, { repoDir, message: PROMPT_MESSAGE, finalToken: REPLY_TOKEN });
        console.log(`measure-footprint: [electron] run ${run}: session settled; waiting ${SETTLE_DELAY_MS}ms before measuring...`);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));

        results.push(measureProcessTree(targetPid));
      } finally {
        cdp?.close();
        if (launcherChild) await stopLauncher(launcherChild);
        await safeRmSync(userDataDir);
        if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
        await safeRmSync(repoDir);
      }
    }
    return results;
  } finally {
    await safeRmSync(shimDir);
  }
}

async function main() {
  console.log('measure-footprint: Rust (Tauri/WebView2, RELEASE build) vs Electron (existing production bundle) process-tree private memory.');
  console.log('measure-footprint: INFORMATIONAL ONLY (2026-10-14 decision) -- not a gate, not a pass/fail threshold, not wired into CI.');
  console.log(
    `measure-footprint: method -- Get-CimInstance Win32_Process (ProcessId/ParentProcessId) snapshot, BFS from the launched root pid to collect every descendant, then ` +
      `Get-Process -Id <tree> | Select Id,ProcessName,PrivateMemorySize64, summed. ${MEASURE_REPEAT_COUNT} fresh-launch samples per shell -- median + min-max range reported, not a single snapshot.`,
  );

  try {
    const rust = await measureRustApp();
    console.log(`measure-footprint: [rust] measured using mode "${rust.mode}": ${rust.label}`);
    rust.runs.forEach((r, i) => logTree(`${rust.label} run ${i + 1}`, r));
    const electronRuns = await measureElectronApp();
    electronRuns.forEach((r, i) => logTree(`Electron run ${i + 1}`, r));

    console.log('measure-footprint: SUMMARY (informational only):');
    const rustSummary = summarizeRuns(rust.label, rust.runs);
    const electronSummary = summarizeRuns('Electron (production bundle)', electronRuns);
    console.log(
      `measure-footprint: ${rust.label} full median ${mib(rustSummary.fullMedian)} MiB (range ${mib(rustSummary.fullMin)}-${mib(rustSummary.fullMax)}), ` +
        `app-only median ${mib(rustSummary.appOnlyMedian)} MiB (range ${mib(rustSummary.appOnlyMin)}-${mib(rustSummary.appOnlyMax)})`,
    );
    console.log(
      `measure-footprint: Electron (production bundle) full median ${mib(electronSummary.fullMedian)} MiB (range ${mib(electronSummary.fullMin)}-${mib(electronSummary.fullMax)}), ` +
        `app-only median ${mib(electronSummary.appOnlyMedian)} MiB (range ${mib(electronSummary.appOnlyMin)}-${mib(electronSummary.appOnlyMax)})`,
    );

    // Final sanity re-check, independent of measureRustApp's own internal checks: the REAL
    // profile must still be exactly what it was before this entire run started.
    const realAfterEverything = snapshotDir(REAL_TAURI_DATA_DIR);
    console.log(`measure-footprint: final check -- REAL_TAURI_DATA_DIR now has ${Object.keys(realAfterEverything).length} file(s) (compare against the isolation-check log above).`);
  } finally {
    // RELEASE_OUTPUT_DIR is this script's own build output (CARGO_TARGET_DIR/release, or
    // src-tauri/target/release when unset) -- deleted by its own literal absolute path once
    // measuring is done. Other lanes build `--debug`/run `cargo test` against the shared target
    // dir's `debug/` profile; this script is the only one that ever populates `release/`, so
    // removing it cannot disturb another lane's in-flight build.
    await safeRmSync(RELEASE_OUTPUT_DIR);
  }
}

main().catch((err) => {
  console.error('measure-footprint: FAIL', err);
  process.exitCode = 1;
});
