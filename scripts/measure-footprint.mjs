#!/usr/bin/env node
// `node scripts/measure-footprint.mjs` (issue #795 part 5, R12b): one-shot, print-a-number tool
// comparing the Rust (Tauri/WebView2) build's process-tree private memory against the Electron
// build's, both driving the exact same recorded-frame `session` fixture scenario
// (scripts/fixtures/omp-frames/session.jsonl via scripts/verify-tauri-fake-omp.mjs) so the two
// numbers describe the same workload: window up, one repository added, one Session created, one
// streamed chat turn with a tool-call approval, settled.
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
// <every pid in that tree> | Select Id,ProcessName,PrivateMemorySize64`, summed. Private memory
// (not working set) is used throughout: it is the commit charge actually attributable to the
// process, not memory that could be paged out or shared with other processes on the machine.
//
// Process lifecycle: both apps are launched exactly like `scripts/verify-tauri.mjs` already does
// for the Rust build -- inside `scripts/verify-tauri-launcher.rs`'s own kill-on-close Win32 Job
// Object (`scripts/verify-tauri-cdp.mjs`'s `launchViaJobObject`/`stopLauncher`, imported and reused
// unchanged here, not duplicated), so tearing either one down is a single OS-level job
// termination, never a `taskkill` of a computed pid. The Electron side is launched the same way:
// the launcher does not care what `targetExe` is, only that it is an exe to spawn inside the job.
// Scratch dirs and the measurement-tool's own build artefacts are cleaned up in a `finally` by
// their own literal, just-created absolute paths.
//
// `scripts/verify-tauri.mjs`'s own build/copy helpers (`buildTauriDebugNoBundle`,
// `copyBuiltExe`, `buildOmpShim`, `buildLauncher`, `makeScratchRepo`) are not exported there (it is
// a self-running CLI script, not a module), so the same few lines are reproduced here rather than
// editing that file (owned by R12a/#795 part 1, already landed in PR #820) to add exports.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Same shared-disk convention every Phase R lane's build step honours (see verify-tauri.mjs's own
// header comment): unset falls back to cargo's own default (`src-tauri/target`), never a
// hard-coded machine path.
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
// Same prompt/token pair verify-tauri.mjs uses for US4: independent strings, so a check against
// the reply token can never pass merely because the echoed prompt happens to contain it.
const PROMPT_MESSAGE = 'Please respond now.';
const REPLY_TOKEN = 'xyzzy9';
// Generous pause after the streamed reply finishes so any post-turn GC/idle-compaction in either
// runtime has a chance to settle before the snapshot -- not a correctness wait (the tool-call
// approval and streamed reply are already awaited to completion above it), just measurement
// hygiene so the number reflects steady state rather than a mid-turn allocation spike.
const SETTLE_DELAY_MS = 3000;

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

/** Builds the Rust app once with no dev server: `tauri build --debug --no-bundle` (never `cargo
 * run`), retried on a transient "Access is denied" -- a shared `CARGO_TARGET_DIR` means another
 * lane's own running process can transiently hold the previous `refract-tauri.exe` open. */
function buildTauriDebugNoBundle() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const env = { ...process.env };
    if (CARGO_TARGET_DIR) env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
    env.CARGO_INCREMENTAL = '0';
    const result = spawnSync_('cmd.exe', ['/c', 'pnpm', 'exec', 'tauri', 'build', '--debug', '--no-bundle'], {
      cwd: REPO_ROOT,
      env,
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) return;
    const locked = /Access is denied/i.test(result.stderr ?? '') || /Access is denied/i.test(result.stdout ?? '');
    if (!locked || attempt === maxAttempts) {
      throw new Error(`buildTauriDebugNoBundle: build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    console.warn(`measure-footprint: build exe locked by another process (shared CARGO_TARGET_DIR), retrying in 30s (attempt ${attempt}/${maxAttempts})...`);
    spawnSync_('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
  }
}

/** Copies the just-built exe to its own scratch dir, so a later build overwriting the shared
 * target dir's own copy never collides with the process already running from it. */
function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
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
 * against a (vanishingly unlikely, but free to guard) pid-reuse cycle in the same snapshot. */
function collectTreePids(rootPid, allProcs) {
  const byParent = new Map();
  for (const p of allProcs) {
    const list = byParent.get(p.ParentProcessId) ?? [];
    list.push(p.ProcessId);
    byParent.set(p.ParentProcessId, list);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const childPid of byParent.get(pid) ?? []) {
      if (!seen.has(childPid)) {
        seen.add(childPid);
        queue.push(childPid);
      }
    }
  }
  return [...seen];
}

/** `Get-Process -Id <every pid in the tree>`, private memory only (the commit charge actually
 * attributable to each process, not working set, which can include memory shared with or
 * page-able out from under other processes on the machine). A pid that already exited between
 * the snapshot and this call (e.g. a short-lived helper) is silently dropped
 * (`-ErrorAction SilentlyContinue`), not treated as a measurement failure. */
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
  const pids = collectTreePids(rootPid, allProcs);
  const procs = measurePrivateMemory(pids).sort((a, b) => b.PrivateMemorySize64 - a.PrivateMemorySize64);
  const totalBytes = procs.reduce((sum, p) => sum + (p.PrivateMemorySize64 ?? 0), 0);
  return { rootPid, pids, procs, totalBytes };
}

function logTree(label, measurement) {
  console.log(`measure-footprint: ${label} process tree (root pid ${measurement.rootPid}, ${measurement.procs.length} process(es) measured of ${measurement.pids.length} pid(s) in the tree):`);
  for (const p of measurement.procs) {
    console.log(`  pid=${p.Id}\tname=${p.ProcessName}\tprivateMemoryBytes=${p.PrivateMemorySize64}\t(${(p.PrivateMemorySize64 / (1024 * 1024)).toFixed(1)} MiB)`);
  }
  console.log(`measure-footprint: ${label} TOTAL private memory: ${measurement.totalBytes} bytes (${(measurement.totalBytes / (1024 * 1024)).toFixed(1)} MiB)`);
}

async function measureRustApp() {
  let shimDir, dataDir, repoDir, exeDir, launcherChild, cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-data-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-repo-')));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-rust-exe-'));
    const port = await getFreePort();

    console.log(`measure-footprint: [rust] shim dir ${shimDir}, data dir ${dataDir}, repo dir ${repoDir}, exe dir ${exeDir}, CDP port ${port}`);
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    console.log('measure-footprint: [rust] building (tauri build --debug --no-bundle, no dev server)...');
    buildTauriDebugNoBundle();
    const exePath = copyBuiltExe(exeDir);
    console.log(`measure-footprint: [rust] built exe copied to ${exePath}`);

    const webview2DataDir = path.join(exeDir, 'webview2-data');
    mkdirSync(webview2DataDir, { recursive: true });
    const pidFile = path.join(exeDir, 'target.pid');
    const env = {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
      REFRACT_DATA_DIR: dataDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      PATH: `${shimDir};${process.env.PATH}`,
    };
    const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
    launcherChild = launched.child;
    const targetPid = launched.targetPid;
    console.log(`measure-footprint: [rust] launched, target pid ${targetPid}`);

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`measure-footprint: [rust] CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
    }
    await waitForReadinessGreen(cdp);
    await openSessionAndSendMessage(cdp, { repoDir, message: PROMPT_MESSAGE });
    console.log(`measure-footprint: [rust] session settled; waiting ${SETTLE_DELAY_MS}ms before measuring...`);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));

    return measureProcessTree(targetPid);
  } finally {
    cdp?.close();
    if (launcherChild) await stopLauncher(launcherChild);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
  }
}

async function measureElectronApp() {
  let userDataDir, repoDir, shimDir, launcherChild, cdp;
  try {
    userDataDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-electron-data-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-footprint-electron-repo-')));
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-footprint-electron-shim-'));
    const port = await getFreePort();

    console.log(`measure-footprint: [electron] user-data dir ${userDataDir}, repo dir ${repoDir}, shim dir ${shimDir}, CDP port ${port}`);
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);

    console.log('measure-footprint: [electron] building (pnpm build:electron)...');
    buildElectron();
    const electronExe = resolveElectronBinary();
    console.log(`measure-footprint: [electron] binary ${electronExe}`);

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
    console.log(`measure-footprint: [electron] launched, target pid ${targetPid}`);

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`measure-footprint: [electron] CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
    }
    await waitForReadinessGreen(cdp);
    await openSessionAndSendMessage(cdp, { repoDir, message: PROMPT_MESSAGE });
    console.log(`measure-footprint: [electron] session settled; waiting ${SETTLE_DELAY_MS}ms before measuring...`);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));

    return measureProcessTree(targetPid);
  } finally {
    cdp?.close();
    if (launcherChild) await stopLauncher(launcherChild);
    await safeRmSync(userDataDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(shimDir);
  }
}

async function main() {
  console.log('measure-footprint: Rust (Tauri/WebView2) vs Electron process-tree private memory.');
  console.log('measure-footprint: INFORMATIONAL ONLY (2026-10-14 decision) -- not a gate, not a pass/fail threshold, not wired into CI.');
  console.log('measure-footprint: method -- Get-CimInstance Win32_Process (ProcessId/ParentProcessId) snapshot, BFS from the launched root pid to collect every descendant, then Get-Process -Id <tree> | Select Id,ProcessName,PrivateMemorySize64, summed.');

  const rust = await measureRustApp();
  logTree('Rust (Tauri)', rust);

  const electron = await measureElectronApp();
  logTree('Electron', electron);

  console.log('measure-footprint: SUMMARY (informational only):');
  console.log(`  Rust (Tauri): ${(rust.totalBytes / (1024 * 1024)).toFixed(1)} MiB total across ${rust.procs.length} process(es)`);
  console.log(`  Electron:     ${(electron.totalBytes / (1024 * 1024)).toFixed(1)} MiB total across ${electron.procs.length} process(es)`);
}

main().catch((err) => {
  console.error('measure-footprint: FAIL', err);
  process.exitCode = 1;
});
