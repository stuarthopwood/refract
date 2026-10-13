#!/usr/bin/env node
// `pnpm verify:tauri` (issue #795 part 1, R12a): CDP-driven proof for the Tauri/WebView2 build.
// Builds once with `pnpm exec tauri build --debug --no-bundle` (no dev server, so no shared
// Vite port 5174 -- a live-run convention all Phase R lanes share, since only one lane can hold
// that port at a time and `cargo run`'s own exe under the shared CARGO_TARGET_DIR can otherwise
// be overwritten mid-run by another lane's build), copies the resulting
// `<CARGO_TARGET_DIR>/debug/refract-tauri.exe` to a scratch dir, and runs THAT COPY directly
// against a scratch data directory and a scratch git repository, with the recorded-frame fake
// `omp` (scripts/verify-tauri-fake-omp.mjs) first on PATH by default. Drives:
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
// swept (every live descendant of that pid is found and force-killed, even one orphaned from an
// already-exited wrapper -- see `stopProcess`'s own doc comment) -- never a kill by name, per
// AGENTS.md's destructive-operations rule applied to processes.
//
// Shared disk note: every cargo/tauri invocation here runs with `CARGO_TARGET_DIR` pointed at the
// shared, already-populated target dir (see this repo's own worktree instructions) -- never a
// fresh `src-tauri/target`. The build step itself still briefly uses the shared target dir's own
// lock (builds serialise there machine-wide); only the copied exe runs concurrently with others.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync } from 'node:fs';
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

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
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

/** Builds the Rust app once with no dev server (the live-run convention, 2026-10-13): `tauri
 * build --debug --no-bundle` runs the renderer's own production build plus `cargo build`
 * (never `cargo run`), so it never touches Vite's shared port 5174 and finishes with a plain
 * exe under the shared `CARGO_TARGET_DIR`, not a running process. Takes a few minutes the first
 * time; the shared target dir makes a rebuild fast once most crates are already compiled. */
function buildTauriDebugNoBundle() {
  // The shared `CARGO_TARGET_DIR` means another lane's own running exe (built from the same
  // crate) can transiently hold `debug/refract-tauri.exe` open, so `cargo build`'s own rename-
  // over-the-old-binary step fails with "Access is denied" until that lane's process exits.
  // Retried, not treated as this run's own failure.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync_('cmd.exe', ['/c', 'pnpm', 'exec', 'tauri', 'build', '--debug', '--no-bundle'], {
      cwd: REPO_ROOT,
      env: { ...process.env, CARGO_TARGET_DIR },
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) return;
    const locked = /Access is denied/i.test(result.stderr ?? '') || /Access is denied/i.test(result.stdout ?? '');
    if (!locked || attempt === maxAttempts) {
      throw new Error(`buildTauriDebugNoBundle: build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    console.warn(`verify-tauri: build exe locked by another process (shared CARGO_TARGET_DIR), retrying in 30s (attempt ${attempt}/${maxAttempts})...`);
    spawnSync_('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
  }
}

/** Copies the just-built exe to its own scratch dir, so two lanes' own runs (and a later build
 * overwriting the shared target dir's own copy) never collide with a process already running. */
function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  copyFileSync(path.join(CARGO_TARGET_DIR, 'debug', 'refract-tauri.exe'), dest);
  return dest;
}

/** Runs the already-built, already-copied exe directly -- no wrapper process, so the pid this
 * returns IS the app (no orphaning risk the old `cmd.exe /c pnpm run dev:tauri` wrapper had).
 * `WEBVIEW2_USER_DATA_FOLDER` (a documented WebView2 env var) gets its own scratch subfolder
 * next to the copied exe: WebView2's default user-data-folder resolution can collide across
 * concurrently running instances sharing an identity, surfacing as `HRESULT(0x8007139F)`
 * ("the group or resource is not in the correct state") -- seen live when another lane's own
 * Tauri instance was running at the same time. */
function launchBuiltExe(exePath, { port, dataDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    ...extraEnv,
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const child = spawn(exePath, [], { cwd: path.dirname(exePath), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  try {
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  } catch (err) {
    const diag = await cdp.evaluate(`({ title: document.title, readyState: document.readyState, href: location.href, bodyText: document.body?.innerText?.slice(0, 500), bodyHtml: document.body?.innerHTML?.slice(0, 1000) })`);
    console.error('verify-tauri: Readiness screen never mounted; page diagnostics:', JSON.stringify(diag, null, 2));
    await cdp.screenshot(path.join(evidenceDir, 'us1-00-diag-failure.png'));
    throw err;
  }
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
  await cdp.waitFor(
    `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'New session dialog open, branches loaded, Create session enabled' },
  );
  await cdp.screenshot(path.join(evidenceDir, 'us4-01b-new-session-dialog.png'));
  const buttonState = await cdp.evaluate(
    `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); if (!b) return null; const r = b.getBoundingClientRect(); return { disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled'), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; })()`,
  );
  console.log('verify-tauri: Create session button state before click:', JSON.stringify(buttonState));
  await cdp.clickByText('Create session', { inDialog: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await cdp.screenshot(path.join(evidenceDir, 'us4-01c-after-create-click.png'));
  const dialogStillOpen = await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`);
  console.log('verify-tauri: dialog still open after Create session click:', dialogStillOpen);

  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
    timeoutMs: 60_000,
    label: 'Session opened, agent attached, composer enabled',
  });
  await cdp.screenshot(path.join(evidenceDir, 'us4-02-session-opened.png'));

  await cdp.typeIntoByLabel('Message', message);
  await cdp.clickByLabel('Send message');

  await cdp.waitFor(
    `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(message)}); })()`,
    { timeoutMs: 30_000, label: 'US4: sent message rendered in transcript' },
  );
  await cdp.screenshot(path.join(evidenceDir, 'us4-03-sent-message.png'));

  // The scenario's `write` tool call raises an approval card (always-ask mode); answering it
  // sends `extension_ui_response`, the gate the session fixture's tape is waiting on.
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`,
    { timeoutMs: 30_000, label: 'US4: approval card rendered' },
  );
  await cdp.clickByText('Approve');

  try {
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.trim().endsWith('ok'); })()`,
      { timeoutMs: 60_000, label: 'US4: streamed assistant reply ("ok") rendered in transcript' },
    );
  } catch (err) {
    const text = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.textContent ?? '(no Transcript element)'`);
    console.error('verify-tauri: streamed reply never matched; transcript textContent:', JSON.stringify(text));
    await cdp.screenshot(path.join(evidenceDir, 'us4-04-diag-failure.png'));
    throw err;
  }
  await cdp.screenshot(path.join(evidenceDir, 'us4-04-streamed-reply.png'));
  console.log('US4 PASS: message sent and streamed reply read back from the transcript DOM.');
}

async function runFakeOmpProof() {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-shim-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-data-'));
  const repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-r12a-repo-')));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-exe-'));
  const evidenceDir = await withEvidenceDir('fake-omp');
  const port = DEFAULT_PORT;

  console.log(`verify-tauri: shim dir ${shimDir}`);
  console.log(`verify-tauri: data dir ${dataDir}`);
  console.log(`verify-tauri: repo dir ${repoDir}`);
  console.log(`verify-tauri: evidence dir ${evidenceDir}`);

  buildOmpShim(shimDir);
  console.log('verify-tauri: building (tauri build --debug --no-bundle, no dev server)...');
  buildTauriDebugNoBundle();
  const exePath = copyBuiltExe(exeDir);
  console.log(`verify-tauri: built exe copied to ${exePath}`);

  const child = launchBuiltExe(exePath, {
    port,
    dataDir,
    pathPrepend: shimDir,
    logFile: path.join(evidenceDir, 'app.log'),
    extraEnv: {
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_DEBUG_LOG: path.join(evidenceDir, 'fake-omp-invocations.log'),
    },
  });
  let cdp;
  try {
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
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
    await safeRmSync(exeDir);
  }
}

/** The one real-omp proof: US1 only, no model turn (ipc/readiness.rs never calls `prompt`). */
async function runRealOmpProof() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-real-data-'));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-real-exe-'));
  const evidenceDir = await withEvidenceDir('real-omp');
  const port = DEFAULT_PORT + 1;

  console.log(`verify-tauri: data dir ${dataDir}`);
  console.log(`verify-tauri: evidence dir ${evidenceDir}`);

  console.log('verify-tauri: building (tauri build --debug --no-bundle, no dev server)...');
  buildTauriDebugNoBundle();
  const exePath = copyBuiltExe(exeDir);
  console.log(`verify-tauri: built exe copied to ${exePath}`);

  const child = launchBuiltExe(exePath, { port, dataDir, logFile: path.join(evidenceDir, 'app.log') });
  let cdp;
  try {
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    await proveUs1(cdp, evidenceDir);
    const omp = await cdp.evaluate(`document.body.innerText`);
    writeFileSync(path.join(evidenceDir, 'us1-page-text.txt'), omp);
    console.log(`verify-tauri: PASS (real omp, US1 only). Evidence: ${evidenceDir}`);
  } finally {
    cdp?.close();
    await stopProcess(child);
    await safeRmSync(dataDir);
    await safeRmSync(exeDir);
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
