#!/usr/bin/env node
// `pnpm verify:tauri` (issue #795 part 1, R12a): CDP-driven proof for the Tauri/WebView2 build.
// Launches `pnpm run dev:tauri` against a scratch data directory and a scratch git repository,
// with the recorded-frame fake `omp` (scripts/verify-tauri-fake-omp.mjs) first on PATH by
// default, attaches over CDP, and drives:
//
//   US1 (window, readiness): the window paints, the readiness checklist goes green, "Add
//       repository" becomes enabled.
//   US4 (chat that streams): add the scratch repository, create a Session, send a message, and
//       read the streamed reply back out of the transcript DOM.
//
// `--real-omp` runs US1 only, against a REAL `omp` resolved from PATH (no fake, no PATH shim) --
// the one real-omp proof this lane's assignment calls for. It does not spend a model turn: the
// readiness checklist only calls `omp --version` and a scratch, no-session `get_state`/
// `get_available_models`/`get_login_providers` round trip (ipc/readiness.rs), never `prompt`.
//
// Every process this script starts is tracked by pid and torn down in a `finally` block, tree-
// killed (`taskkill /PID <pid> /T /F`) so the Vite dev server, `cargo`/the Tauri CLI, and the
// built `refract-tauri.exe` (and, for the real-omp run, the `omp.exe` it spawns) all go with it --
// never a kill by name, per AGENTS.md's destructive-operations rule applied to processes.
//
// Shared disk note: every cargo/tauri invocation here runs with `CARGO_TARGET_DIR` pointed at the
// shared, already-populated target dir (see this repo's own worktree instructions) -- never a
// fresh `src-tauri/target`.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCdpTarget, CdpSession, stopProcess } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR || 'C:/Users/shopwood/.cargo-target/refract';
const DEFAULT_PORT = 9351;

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Best-effort recursive delete: a Windows file handle from the just-stopped process tree
 * (vite, cargo, the built exe, the fake-omp Node child) can still be closing asynchronously
 * for a moment after `taskkill /T /F` returns, so EPERM/EBUSY here must never mask the proof's
 * own pass/fail result -- it is logged and otherwise ignored, never thrown. */
async function safeRmSync(dir) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-tauri: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** Compiles the native PATH shim (scripts/verify-tauri-omp-shim.rs) into `<dir>/omp.exe` with a
 * bare `rustc` call -- no Cargo project, so it never touches `CARGO_TARGET_DIR` or any shared
 * lock. Takes well under a second (a ~40-line, dependency-free single file). */
function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) {
    throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  }
  return out;
}

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

/** A minimal scratch git repository to add as a Repository: one commit on `main`, nothing else.
 * Never under C:/Repos/personal (AGENTS.md: never seed a repo there); always a fresh mkdtemp. */
function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => spawnSync_('git', ['-C', dir, ...args]);
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=verify-tauri', '-c', 'user.email=verify-tauri@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function launchDevTauri({ port, dataDir, pathPrepend, extraEnv = {}, logFile }) {
  const env = {
    ...process.env,
    CARGO_TARGET_DIR,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    REFRACT_DATA_DIR: dataDir,
    ...extraEnv,
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  // `cmd.exe /c` wraps pnpm's own `.cmd` shim; the resulting pid is the root of the whole tree
  // (vite, the tauri CLI, cargo, the built exe) for a single tree-kill at shutdown.
  const child = spawn('cmd.exe', ['/c', 'pnpm', 'run', 'dev:tauri'], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return child;
}

async function withEvidenceDir(name) {
  const dir = path.join(tmpdir(), `refract-tauri-verify-r12a-${name}-${nowStamp()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** US1: readiness goes green and "Add repository" becomes enabled. Works against either the fake
 * or a real `omp`: the readiness checklist is the same RPC round trip either way. */
async function proveUs1(cdp, evidenceDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.screenshot(path.join(evidenceDir, 'us1-01-readiness-loading.png'));
  try {
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'US1: readiness checklist all green (Add repository enabled)' },
    );
  } catch (err) {
    const text = await cdp.evaluate(`document.body.innerText`);
    console.error('verify-tauri: US1 readiness never went green; page text at failure:\n' + text);
    throw err;
  }
  await cdp.screenshot(path.join(evidenceDir, 'us1-02-readiness-green.png'));
  console.log('US1 PASS: window painted, readiness green, Add repository enabled.');
}

/** US4: add the scratch repository, create a Session, send a message, read the streamed reply. */
async function proveUs4(cdp, evidenceDir, { repoDir, message }) {
  await cdp.click(`document.querySelector('[data-readiness-primary]')`);
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: repoDir });
  await cdp.clickByText('Add repository', { inDialog: true });
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, {
    timeoutMs: 30_000,
    label: 'Repository added, session-list row rendered',
  });
  await cdp.screenshot(path.join(evidenceDir, 'us4-01-repository-added.png'));

  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session')`, {
    timeoutMs: 15_000,
    label: 'New session dialog open',
  });
  await cdp.clickByText('Create session', { inDialog: true });

  await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 60_000, label: 'Session opened, composer mounted' });
  await cdp.screenshot(path.join(evidenceDir, 'us4-02-session-opened.png'));

  await cdp.typeIntoByLabel('Message', message);
  await cdp.clickByLabel('Send message');

  await cdp.waitFor(
    `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(message)}); })()`,
    { timeoutMs: 30_000, label: 'US4: sent message rendered in transcript' },
  );
  await cdp.screenshot(path.join(evidenceDir, 'us4-03-sent-message.png'));

  await cdp.waitFor(
    `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && /\\bok\\b/.test(t.textContent); })()`,
    { timeoutMs: 60_000, label: 'US4: streamed assistant reply ("ok") rendered in transcript' },
  );
  await cdp.screenshot(path.join(evidenceDir, 'us4-04-streamed-reply.png'));
  console.log('US4 PASS: message sent and streamed reply read back from the transcript DOM.');
}

async function runFakeOmpProof() {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-shim-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-data-'));
  const repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-r12a-repo-')));
  const evidenceDir = await withEvidenceDir('fake-omp');
  const port = DEFAULT_PORT;

  console.log(`verify-tauri: shim dir ${shimDir}`);
  console.log(`verify-tauri: data dir ${dataDir}`);
  console.log(`verify-tauri: repo dir ${repoDir}`);
  console.log(`verify-tauri: evidence dir ${evidenceDir}`);

  buildOmpShim(shimDir);

  const child = launchDevTauri({
    port,
    dataDir,
    pathPrepend: shimDir,
    logFile: path.join(evidenceDir, 'dev-tauri.log'),
    extraEnv: {
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_DEBUG_LOG: path.join(evidenceDir, 'fake-omp-invocations.log'),
    },
  });
  let cdp;
  try {
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 180_000 });
    cdp = await CdpSession.connect(wsUrl);
    await proveUs1(cdp, evidenceDir);
    await proveUs4(cdp, evidenceDir, { repoDir, message: 'Reply with the single word ok' });
    console.log(`verify-tauri: PASS (fake omp). Evidence: ${evidenceDir}`);
  } finally {
    cdp?.close();
    await stopProcess(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(repoDir);
  }
}

/** The one real-omp proof: US1 only, no model turn (ipc/readiness.rs never calls `prompt`). */
async function runRealOmpProof() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-real-data-'));
  const evidenceDir = await withEvidenceDir('real-omp');
  const port = DEFAULT_PORT + 1;

  console.log(`verify-tauri: data dir ${dataDir}`);
  console.log(`verify-tauri: evidence dir ${evidenceDir}`);

  const child = launchDevTauri({ port, dataDir });
  let cdp;
  try {
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 180_000 });
    cdp = await CdpSession.connect(wsUrl);
    await proveUs1(cdp, evidenceDir);
    const omp = await cdp.evaluate(`document.body.innerText`);
    writeFileSync(path.join(evidenceDir, 'us1-page-text.txt'), omp);
    console.log(`verify-tauri: PASS (real omp, US1 only). Evidence: ${evidenceDir}`);
  } finally {
    cdp?.close();
    await stopProcess(child);
    await safeRmSync(dataDir);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--real-omp')) {
    await runRealOmpProof();
  } else {
    await runFakeOmpProof();
  }
}

main().catch((err) => {
  console.error('verify-tauri: FAIL');
  console.error(err);
  process.exitCode = 1;
});
