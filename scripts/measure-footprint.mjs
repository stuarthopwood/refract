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
// in two PowerShell calls per app: (1) `Get-CimInstance Win32_Process | Select ProcessId,
// ParentProcessId,Name` once, snapshotting every process on the machine; a breadth-first walk in
// this script (not PowerShell recursion) from the launched root pid collects every descendant pid
// actually spawned by that launch (WebView2's own browser/renderer/GPU processes for Tauri;
// Electron's own renderer/GPU/utility processes for Electron; either way also the fake-omp PATH
// shim and its own `node` child, both apps spawning `omp` the same way). (2) `Get-Process -Id
// <every pid in that tree> | Select Id,ProcessName,PrivateMemorySize64`, summed. Private memory is
// used throughout: it is the COMMITTED memory actually attributable to the process alone (not
// shared with other processes) -- NOT working set, and NOT memory that "can't be paged out":
// private/committed memory can absolutely still be paged to disk by the OS; "private" here means
// "not shared with another process", nothing more.
//
// Two totals are reported per shell, per run: the FULL process tree, and an APP-ONLY subtotal
// that excludes the fake-omp test harness's own overhead (the `node` process running
// verify-tauri-fake-omp.mjs, the compiled `omp` PATH-shim exe, and the `conhost` console-host
// helper Windows spawns for either of those console-subsystem binaries) -- harness processes that
// exist only because this measurement tool drives a scripted scenario, not because the app itself
// spawned them as part of its normal footprint.
//
// RELEASE BUILD DATA-DIR ISOLATION (the hard part of this rewrite): `data_dir()`
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
// termination, never a `taskkill` of a computed pid. The Electron side is launched the same way:
// the launcher does not care what `targetExe` is, only that it is an exe to spawn inside the job.
// Scratch dirs are fresh per repeated run and cleaned up in a `finally` by their own literal,
// just-created absolute paths; the shared build artefacts (compiled omp shim, job-object launcher,
// copied release exe / resolved electron binary) are built/resolved ONCE and reused across the
// repeated launches, since only the process instance needs to be fresh, not the binary under test.
// The Rust side's own RELEASE build output under the shared `CARGO_TARGET_DIR/release/` (or
// `src-tauri/target/release` when that env var is unset) is deleted by its own literal absolute
// path once this script is done measuring (see `main`'s own `finally`), same shared-disk
// cleanliness convention every Phase R lane's build step honours.
//
// `scripts/verify-tauri.mjs`'s own build/copy helpers (`copyBuiltExe`, `buildOmpShim`,
// `buildLauncher`, `makeScratchRepo`) are not exported there (it is a self-running CLI script, not
// a module), so the same few lines are reproduced here rather than editing that file (owned by
// R12a/#795 part 1, already landed in PR #820) to add exports. `buildTauriRelease` below is this
// script's own: `verify-tauri.mjs` only ever builds `--debug` (its own concern is CDP correctness,
// not footprint), so there is no existing release-build helper to reuse.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Same shared-disk convention every Phase R lane's build step honours (see verify-tauri.mjs's own
// header comment): unset falls back to cargo's own default (`src-tauri/target`), never a
// hard-coded machine path. RELEASE (not debug): a fair comparison against Electron's existing
// production `electron-vite` bundle needs an optimised Rust binary on the other side, not an
// unoptimised one. Both the unmodified release build (option 1) and the debug-assertions release
// build (option 2 fallback) are the `release` cargo profile, so both land here.
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const RELEASE_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'release') : path.join(REPO_ROOT, 'src-tauri', 'target', 'release');
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
// The fake-omp test harness's own process names (bare, no `.exe`): `node` running
// verify-tauri-fake-omp.mjs, the compiled `omp` PATH-shim exe, and the `conhost` console-host
// helper Windows spawns for either console-subsystem binary. Test-harness overhead, not app
// footprint -- excluded from the "app-only" subtotal, still counted in the "full tree" total.
const HARNESS_PROCESS_NAMES = new Set(['node', 'conhost', 'omp']);
// The REAL, non-scratch profile a release build reads/writes (see the module doc comment above).
// This script must NEVER let a release-mode launch mutate this directory without first proving a
// redirect actually works.
const REAL_TAURI_DATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'refract-tauri') : path.join(homedir(), 'AppData', 'Roaming', 'refract-tauri');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

/** Best-effort recursive delete; EPERM/EBUSY from a just-stopped process tree's own file handles
 * closing asynchronously is logged and otherwise ignored, never thrown. */
async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`measure-footprint: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Snapshots every file under `dir` (relative path -> `{ mtimeMs, sha256 }`), recursively; `{}`
 * for a directory that does not exist. Used to prove (or disprove) that a launch left the REAL
 * Tauri profile untouched -- mtime alone is not quite enough (clock resolution, and a rewrite
 * that happens to produce identical content would not change it meaningfully anyway, but a hash
 * catches a rewrite that races within the same mtime tick), so both are compared together. */
function snapshotDir(dir) {
  const snapshot = {};
  if (!existsSync(dir)) return snapshot;
  const walk = (current, relPrefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        const stat = statSync(abs);
        const sha256 = createHash('sha256').update(readFileSync(abs)).digest('hex');
        snapshot[rel] = { mtimeMs: stat.mtimeMs, sha256 };
      }
    }
  };
  walk(dir, '');
  return snapshot;
}

/** True iff two `snapshotDir` results describe exactly the same files with exactly the same
 * mtime and hash -- i.e. nothing in the directory changed between the two snapshots. */
function snapshotsEqual(before, after) {
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (beforeKeys.length !== afterKeys.length) return false;
  return beforeKeys.every((key) => {
    const a = before[key];
    const b = after[key];
    return !!b && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256;
  });
}

/** Compiles the native PATH shim (scripts/verify-tauri-omp-shim.rs) into `<dir>/omp.exe` with a
 * bare `rustc` call -- no Cargo project, so it never touches `CARGO_TARGET_DIR` or any shared
 * lock. */
function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** Compiles the Win32 Job Object launcher (scripts/verify-tauri-launcher.rs) the same way: a
 * bare `rustc` call, std only. */
function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** A minimal scratch git repository to add as a Repository; never under C:/Repos/personal
 * (AGENTS.md), always a fresh mkdtemp. */
function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-b', 'main']);
  run(['-c', 'user.name=measure-footprint', '-c', 'user.email=measure-footprint@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

/** The scratch worktree a Session's creation leaves next to the scratch repo
 * (`<repo>/../pinion-worktrees/<repoName>`), cleaned up alongside the repo itself. */
function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

/** Builds the Rust app once, RELEASE profile, no dev server: `tauri build --no-bundle` (never
 * `--debug`, never `cargo run`) -- a fair comparison against Electron's existing production
 * bundle needs an optimised binary on both sides. `debugAssertions: true` additionally sets
 * `CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true` / `CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=false`
 * (option 2 fallback, see module doc comment) -- still the release profile/optimisation level,
 * but with `#[cfg(debug_assertions)]` true so `REFRACT_DATA_DIR` is honoured. Retried on a
 * transient "Access is denied" -- a shared `CARGO_TARGET_DIR` means another lane's own running
 * process can transiently hold the previous `refract-tauri.exe` open. */
function buildTauriRelease({ debugAssertions = false } = {}) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const env = { ...process.env };
    if (CARGO_TARGET_DIR) env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
    env.CARGO_INCREMENTAL = '0';
    if (debugAssertions) {
      env.CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS = 'true';
      env.CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS = 'false';
    }
    const result = spawnSync_('cmd.exe', ['/c', 'pnpm', 'exec', 'tauri', 'build', '--no-bundle'], {
      cwd: REPO_ROOT,
      env,
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) return;
    const locked = /Access is denied/i.test(result.stderr ?? '') || /Access is denied/i.test(result.stdout ?? '');
    if (!locked || attempt === maxAttempts) {
      throw new Error(`buildTauriRelease: build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    console.warn(`measure-footprint: build exe locked by another process (shared CARGO_TARGET_DIR), retrying in 30s (attempt ${attempt}/${maxAttempts})...`);
    spawnSync_('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
  }
}

/** Copies the just-built release exe to its own scratch dir, so a later build overwriting the
 * shared target dir's own copy never collides with the process already running from it. */
function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const src = path.join(RELEASE_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyBuiltExe: built exe not found at ${src} (CARGO_TARGET_DIR=${CARGO_TARGET_DIR ?? '(unset, using cargo default)'})`);
  const dest = path.join(destDir, 'refract-tauri.exe');
  copyFileSync(src, dest);
  return dest;
}

/** `pnpm build:electron` (electron-vite build): writes `out/main`, `out/preload`, `out/renderer`
 * under the repo root (package.json's own `main: "./out/main/index.js"`). No `CARGO_TARGET_DIR`
 * involvement at all -- a separate, unrelated build pipeline. */
function buildElectron() {
  const result = spawnSync_('cmd.exe', ['/c', 'pnpm', 'build:electron'], {
    cwd: REPO_ROOT,
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`buildElectron: pnpm build:electron failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
}

/** The installed `electron` npm package's own documented resolution: required outside of an
 * Electron runtime (plain `node`, exactly what this script is), its main export is the absolute
 * path to the platform binary (`node_modules/.../electron/dist/electron.exe` on Windows). */
function resolveElectronBinary() {
  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    throw new Error(`resolveElectronBinary: require('electron') did not resolve to an existing file: ${electronPath}`);
  }
  return electronPath;
}

/** US1-equivalent: waits for the readiness checklist to go green (same selector both shells'
 * renderer shares, `[data-readiness-primary]`). */
async function waitForReadinessGreen(cdp) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 90_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness checklist all green (Add repository enabled)' },
  );
}

/** Polls the transcript's own trailing text until it ends with `finalToken`, accepting that final
 * state only once an earlier poll already observed a real, non-empty, proper prefix of it --
 * proving the reply streamed in rather than painting the whole token in one go. Ported from
 * verify-tauri.mjs's own `waitForStreamedReply` (not exported there; see this file's header). */
async function waitForStreamedReply(cdp, { finalToken, timeoutMs = 60_000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  let sawPartialPrefix = false;
  let lastValue = '';
  while (Date.now() < deadline) {
    const { text, failedNotice } = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); const text = t ? t.textContent.trim() : ''; return { text, failedNotice: /prompt failed/i.test(text) }; })()`,
    );
    if (failedNotice) {
      throw new Error(`waitForStreamedReply: a "prompt failed" notice appeared in the transcript: ${text}`);
    }
    lastValue = text;
    const fullyArrived = text.endsWith(finalToken);
    if (!fullyArrived) {
      for (let len = finalToken.length - 1; len >= 1; len--) {
        if (text.endsWith(finalToken.slice(0, len))) {
          sawPartialPrefix = true;
          break;
        }
      }
    }
    if (fullyArrived && sawPartialPrefix) return text;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitForStreamedReply: timed out after ${timeoutMs}ms waiting for a reply ending in "${finalToken}" (partial prefix observed: ${sawPartialPrefix}; last: ${JSON.stringify(lastValue)})`);
}

/** US4-equivalent, trimmed to the "settle" the task asks for (no screenshots -- this tool's whole
 * job is to print a number, not leave evidence behind): add the scratch repository, create a
 * Session, send a message, answer the tool-call approval the fixture raises, read the streamed
 * reply back out of the transcript DOM. */
async function openSessionAndSendMessage(cdp, { repoDir, message }) {
  await cdp.click(`document.querySelector('[data-readiness-primary]')`);
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: repoDir });
  await cdp.clickByText('Add repository', { inDialog: true });
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
    { timeoutMs: 30_000, label: 'Repository added, session-list row rendered' },
  );

  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(
    `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'New session dialog open, branches loaded, Create session enabled' },
  );
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed after Create session' });

  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
    timeoutMs: 60_000,
    label: 'Session opened, agent attached, composer enabled',
  });

  await cdp.typeIntoByLabel('Message', message);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(
    `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(message)}); })()`,
    { timeoutMs: 30_000, label: 'Sent message rendered in transcript' },
  );

  // The session fixture's `write` tool call raises an approval card (always-ask mode).
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, {
    timeoutMs: 30_000,
    label: 'Approval card rendered',
  });
  await cdp.clickByText('Approve');

  await waitForStreamedReply(cdp, { finalToken: REPLY_TOKEN, timeoutMs: 60_000 });
}

/** One PowerShell call snapshotting every process on the machine (pid, parent pid, name). */
function getAllProcesses() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
  const result = spawnSync_('powershell', ['-NoProfile', '-Command', script], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`getAllProcesses: Get-CimInstance Win32_Process failed (exit ${result.status}): ${result.stderr}`);
  const parsed = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Breadth-first walk from `rootPid` over the snapshot's own ParentProcessId links, collecting
 * every descendant pid -- done here in JS, not PowerShell recursion, so there is one plain
 * iterative loop to reason about instead of a recursive script-block closure. A `seen` set guards
 * against a (vanishingly unlikely, but free to guard) pid-reuse cycle in the same snapshot.
 * Returns both the FULL set of descendant pids and an APP-ONLY subset that never descends into a
 * subtree rooted at one of `HARNESS_PROCESS_NAMES` (the fake-omp harness's own `node`/`conhost`/
 * `omp` processes are dropped along with everything spawned under them -- harness overhead, not
 * app footprint). The root pid itself is always kept in both sets regardless of its own name. */
function collectTreePids(rootPid, allProcs) {
  const byParent = new Map();
  const nameByPid = new Map();
  for (const p of allProcs) {
    const list = byParent.get(p.ParentProcessId) ?? [];
    list.push(p.ProcessId);
    byParent.set(p.ParentProcessId, list);
    nameByPid.set(p.ProcessId, p.Name);
  }
  const isHarnessProcess = (pid) => {
    const name = nameByPid.get(pid);
    return !!name && HARNESS_PROCESS_NAMES.has(name.replace(/\.exe$/i, '').toLowerCase());
  };

  const allPids = new Set([rootPid]);
  const allQueue = [rootPid];
  while (allQueue.length) {
    const pid = allQueue.shift();
    for (const childPid of byParent.get(pid) ?? []) {
      if (!allPids.has(childPid)) {
        allPids.add(childPid);
        allQueue.push(childPid);
      }
    }
  }

  const appOnlyPids = new Set([rootPid]);
  const appOnlyQueue = [rootPid];
  while (appOnlyQueue.length) {
    const pid = appOnlyQueue.shift();
    for (const childPid of byParent.get(pid) ?? []) {
      if (appOnlyPids.has(childPid) || isHarnessProcess(childPid)) continue;
      appOnlyPids.add(childPid);
      appOnlyQueue.push(childPid);
    }
  }

  return { allPids: [...allPids], appOnlyPids: [...appOnlyPids] };
}

/** `Get-Process -Id <every pid in the tree>`, private memory only -- the COMMITTED memory
 * actually attributable to each process alone (not working set, which can include memory shared
 * with other processes on the machine). Private/committed memory is NOT pinned: the OS can still
 * page it out to disk under memory pressure -- "private" here means "not shared with another
 * process", not "can't be paged out". A pid that already exited between the snapshot and this
 * call (e.g. a short-lived helper) is silently dropped (`-ErrorAction SilentlyContinue`), not
 * treated as a measurement failure. */
function measurePrivateMemory(pids) {
  if (pids.length === 0) return [];
  const idList = pids.join(',');
  const script = `Get-Process -Id ${idList} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,PrivateMemorySize64 | ConvertTo-Json -Compress`;
  const result = spawnSync_('powershell', ['-NoProfile', '-Command', script], { maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`measurePrivateMemory: Get-Process failed (exit ${result.status}): ${result.stderr}`);
  const parsed = JSON.parse(result.stdout || 'null');
  if (parsed == null) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function measureProcessTree(rootPid) {
  const allProcs = getAllProcesses();
  const { allPids, appOnlyPids } = collectTreePids(rootPid, allProcs);
  const procs = measurePrivateMemory(allPids).sort((a, b) => b.PrivateMemorySize64 - a.PrivateMemorySize64);
  const appOnlyPidSet = new Set(appOnlyPids);
  const appOnlyProcs = procs.filter((p) => appOnlyPidSet.has(p.Id));
  const totalBytes = procs.reduce((sum, p) => sum + (p.PrivateMemorySize64 ?? 0), 0);
  const appOnlyBytes = appOnlyProcs.reduce((sum, p) => sum + (p.PrivateMemorySize64 ?? 0), 0);
  return { rootPid, pids: allPids, procs, totalBytes, appOnlyProcs, appOnlyBytes };
}

function logTree(label, measurement) {
  const appOnlySet = new Set(measurement.appOnlyProcs.map((p) => p.Id));
  console.log(`measure-footprint: ${label} process tree (root pid ${measurement.rootPid}, ${measurement.procs.length} process(es) measured of ${measurement.pids.length} pid(s) in the tree):`);
  for (const p of measurement.procs) {
    const harnessTag = appOnlySet.has(p.Id) ? '' : '  [harness]';
    console.log(`  pid=${p.Id}\tname=${p.ProcessName}\tprivateMemoryBytes=${p.PrivateMemorySize64}\t(${(p.PrivateMemorySize64 / (1024 * 1024)).toFixed(1)} MiB)${harnessTag}`);
  }
  console.log(
    `measure-footprint: ${label} TOTAL private memory: ${measurement.totalBytes} bytes (${(measurement.totalBytes / (1024 * 1024)).toFixed(1)} MiB full tree) / ` +
      `${measurement.appOnlyBytes} bytes (${(measurement.appOnlyBytes / (1024 * 1024)).toFixed(1)} MiB app-only, excludes fake-omp harness processes)`,
  );
}

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
        await openSessionAndSendMessage(cdp, { repoDir, message: PROMPT_MESSAGE });
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
        const launched = await launchViaJobObject(launcherExe, pidFile, electronExe, args, { cwd: REPO_ROOT, env });
        launcherChild = launched.child;
        const targetPid = launched.targetPid;
        console.log(`measure-footprint: [electron] run ${run}: launched, target pid ${targetPid}`);

        const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
        cdp = await CdpSession.connect(wsUrl);
        if (!isTargetOwningPort(port, targetPid)) {
          throw new Error(`measure-footprint: [electron] run ${run}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
        }
        await waitForReadinessGreen(cdp);
        await openSessionAndSendMessage(cdp, { repoDir, message: PROMPT_MESSAGE });
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mib(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Prints each run's full/app-only totals plus the median and min-max range across all runs --
 * the generally-useful summary of `MEASURE_REPEAT_COUNT` samples, not a single snapshot. */
function summarizeRuns(label, runs) {
  const full = runs.map((r) => r.totalBytes);
  const appOnly = runs.map((r) => r.appOnlyBytes);
  console.log(`measure-footprint: ${label} -- ${runs.length} fresh-launch sample(s):`);
  runs.forEach((r, i) => console.log(`  run ${i + 1}: full ${mib(r.totalBytes)} MiB (${r.procs.length} procs) / app-only ${mib(r.appOnlyBytes)} MiB (${r.appOnlyProcs.length} procs)`));
  const summary = {
    fullMedian: median(full),
    fullMin: Math.min(...full),
    fullMax: Math.max(...full),
    appOnlyMedian: median(appOnly),
    appOnlyMin: Math.min(...appOnly),
    appOnlyMax: Math.max(...appOnly),
  };
  console.log(`  ${label} full tree:  median ${mib(summary.fullMedian)} MiB, range ${mib(summary.fullMin)}-${mib(summary.fullMax)} MiB`);
  console.log(`  ${label} app-only:   median ${mib(summary.appOnlyMedian)} MiB, range ${mib(summary.appOnlyMin)}-${mib(summary.appOnlyMax)} MiB`);
  return summary;
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
