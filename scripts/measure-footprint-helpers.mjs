// Shared helpers for scripts/measure-footprint.mjs (issue #795 part 5, R12b), split out solely to
// keep both files under the 600-line soft cap (issue #806) -- no behavioural change from having
// this code inline in measure-footprint.mjs. Three groups, in file order: (1) generic scratch-dir/
// snapshot utilities, (2) build helpers (native rustc shims, the Rust release build, Electron's
// production bundle), (3) CDP-driven scripted-flow helpers, (4) process-tree private-memory
// measurement, (5) run-summary helpers (median/min-max). See measure-footprint.mjs's own header
// comment for the full method/isolation-proof rationale; this file is pure mechanism.

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Same shared-disk convention every Phase R lane's build step honours (see verify-tauri.mjs's own
// header comment): unset falls back to cargo's own default (`src-tauri/target`), never a
// hard-coded machine path. RELEASE (not debug): a fair comparison against Electron's existing
// production `electron-vite` bundle needs an optimised Rust binary on the other side.
export const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
export const RELEASE_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'release') : path.join(REPO_ROOT, 'src-tauri', 'target', 'release');
// The fake-omp test harness's own process names (bare, no `.exe`): `node` running
// verify-tauri-fake-omp.mjs, the compiled `omp` PATH-shim exe, and the `conhost` console-host
// helper Windows spawns for either console-subsystem binary. Test-harness overhead, not app
// footprint -- excluded from the "app-only" subtotal, still counted in the "full tree" total.
const HARNESS_PROCESS_NAMES = new Set(['node', 'conhost', 'omp']);

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

/** Best-effort recursive delete; EPERM/EBUSY from a just-stopped process tree's own file handles
 * closing asynchronously is logged and otherwise ignored, never thrown. */
export async function safeRmSync(dir) {
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
export function snapshotDir(dir) {
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
export function snapshotsEqual(before, after) {
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
export function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** Compiles the Win32 Job Object launcher (scripts/verify-tauri-launcher.rs) the same way: a
 * bare `rustc` call, std only. */
export function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** A minimal scratch git repository to add as a Repository; never under C:/Repos/personal
 * (AGENTS.md), always a fresh mkdtemp. */
export function makeScratchRepo(dir) {
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
export function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

/** Builds the Rust app once, RELEASE profile, no dev server: `tauri build --no-bundle` (never
 * `--debug`, never `cargo run`) -- a fair comparison against Electron's existing production
 * bundle needs an optimised binary on both sides. `debugAssertions: true` additionally sets
 * `CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true` / `CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=false`
 * (option 2 fallback, see measure-footprint.mjs's own module doc comment) -- still the release
 * profile/optimisation level, but with `#[cfg(debug_assertions)]` true so `REFRACT_DATA_DIR` is
 * honoured. Retried on a transient "Access is denied" -- a shared `CARGO_TARGET_DIR` means another
 * lane's own running process can transiently hold the previous `refract-tauri.exe` open. */
export function buildTauriRelease({ debugAssertions = false } = {}) {
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
export function copyBuiltExe(destDir) {
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
export function buildElectron() {
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
export function resolveElectronBinary() {
  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    throw new Error(`resolveElectronBinary: require('electron') did not resolve to an existing file: ${electronPath}`);
  }
  return electronPath;
}

/** US1-equivalent: waits for the readiness checklist to go green (same selector both shells'
 * renderer shares, `[data-readiness-primary]`). */
export async function waitForReadinessGreen(cdp) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 90_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness checklist all green (Add repository enabled)' },
  );
}

/** Polls the transcript's own trailing text until it ends with `finalToken`, accepting that final
 * state only once an earlier poll already observed a real, non-empty, proper prefix of it --
 * proving the reply streamed in rather than painting the whole token in one go. Ported from
 * verify-tauri.mjs's own `waitForStreamedReply` (not exported there; see measure-footprint.mjs's
 * own header comment). */
export async function waitForStreamedReply(cdp, { finalToken, timeoutMs = 60_000, intervalMs = 250 }) {
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
export async function openSessionAndSendMessage(cdp, { repoDir, message, finalToken }) {
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

  await waitForStreamedReply(cdp, { finalToken, timeoutMs: 60_000 });
}

/** One PowerShell call snapshotting every process on the machine (pid, parent pid, name). */
export function getAllProcesses() {
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
export function collectTreePids(rootPid, allProcs) {
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
export function measurePrivateMemory(pids) {
  if (pids.length === 0) return [];
  const idList = pids.join(',');
  const script = `Get-Process -Id ${idList} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,PrivateMemorySize64 | ConvertTo-Json -Compress`;
  const result = spawnSync_('powershell', ['-NoProfile', '-Command', script], { maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`measurePrivateMemory: Get-Process failed (exit ${result.status}): ${result.stderr}`);
  const parsed = JSON.parse(result.stdout || 'null');
  if (parsed == null) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function measureProcessTree(rootPid) {
  const allProcs = getAllProcesses();
  const { allPids, appOnlyPids } = collectTreePids(rootPid, allProcs);
  const procs = measurePrivateMemory(allPids).sort((a, b) => b.PrivateMemorySize64 - a.PrivateMemorySize64);
  const appOnlyPidSet = new Set(appOnlyPids);
  const appOnlyProcs = procs.filter((p) => appOnlyPidSet.has(p.Id));
  const totalBytes = procs.reduce((sum, p) => sum + (p.PrivateMemorySize64 ?? 0), 0);
  const appOnlyBytes = appOnlyProcs.reduce((sum, p) => sum + (p.PrivateMemorySize64 ?? 0), 0);
  return { rootPid, pids: allPids, procs, totalBytes, appOnlyProcs, appOnlyBytes };
}

export function logTree(label, measurement) {
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

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mib(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Prints each run's full/app-only totals plus the median and min-max range across all runs --
 * the generally-useful summary of however many samples were taken, not a single snapshot. */
export function summarizeRuns(label, runs) {
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
