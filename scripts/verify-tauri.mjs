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
//       read the streamed reply back out of the transcript DOM (asserts the content changes
//       over more than one poll before settling, not just a single final render).
//
// `--real-omp` runs US1 only, against a REAL `omp` resolved from PATH (no fake, no PATH shim) --
// the one real-omp proof this lane's assignment calls for. It does not spend a model turn: the
// readiness checklist only calls `omp --version` and a scratch, no-session `get_state`/
// `get_available_models`/`get_login_providers` round trip (ipc/readiness.rs), never `prompt`.
//
// Not covered by this harness (left for R12b, issue #795 part 3 onward): ported Rust test cases,
// the transcript golden tests, the cross-shell contract replay, generated frame types, and the
// performance/footprint proof. Only `readiness` and `session` (US1/US4) are ever driven here;
// `side-chat`/`subagents`/`failure`/`exit` are fixtures for the R3/R5/R6 lanes to drive once they
// port those channels (`scripts/fixtures/omp-frames/README.md`), not exercised by this script.
//
// Every process this script starts is tracked by pid (via `launchTracked`) and torn down in a
// `finally` block, tree-swept (every live descendant of that pid is found and force-killed,
// validated by creation time so a stale/reused pid can never be adopted -- see `stopProcess`'s
// own doc comment) -- never a kill by name, per AGENTS.md's destructive-operations rule applied
// to processes.
//
// Shared disk note: when `CARGO_TARGET_DIR` is set in the environment, every cargo/tauri
// invocation here uses it (see this repo's own worktree instructions for the shared path); when
// unset, cargo's own default applies (a plain CI runner has no shared-cache constraint to honour,
// and hard-coding one machine's path here would silently point CI at a path that does not exist
// there). The build step briefly uses that target dir's own lock when it is shared (builds
// serialise there machine-wide); only the copied exe runs concurrently with others.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopProcess, launchTracked, isPortOwnedBy } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Unset when the caller hasn't pointed at a shared cache: `cargo`/`tauri` then fall back to their
// own default (`src-tauri/target`), which is exactly right on a CI runner with no shared-disk
// constraint and no machine-specific path to assume (gate-fix, code review MEDIUM: the previous
// hard-coded `C:/Users/shopwood/...` default tied the harness to one machine).
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
// Where the built exe actually lands, mirroring cargo's own resolution: under `CARGO_TARGET_DIR`
// when set, else `src-tauri/target` (cargo's default for a manifest at `src-tauri/Cargo.toml`).
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
// A token the fake omp's assistant reply ends with, chosen to never collide with the prompt text
// itself (gate-fix, code/tests review MEDIUM: the previous prompt and reply both happened to end
// in "ok", so the final-state check passed even though it could not tell the assistant's own
// reply apart from the user's echoed prompt).
const REPLY_TOKEN = 'xyzzy9';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Best-effort recursive delete: a Windows file handle from the just-stopped process tree
 * (the built exe, WebView2, the fake-omp Node child) can still be closing asynchronously for a
 * moment after `stopProcess` returns, so EPERM/EBUSY here must never mask the proof's own
 * pass/fail result -- it is logged and otherwise ignored, never thrown. */
async function safeRmSync(dir) {
  if (!dir) return;
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
 * Never under C:/Repos/personal (AGENTS.md: never seed a repo there); always a fresh mkdtemp.
 * Throws with `git`'s own stderr on either command failing (gate-fix, code review MEDIUM: a
 * silently-ignored git failure used to surface only as a vague "repository added" timeout much
 * later, with no clue the repo itself was never valid). */
function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) {
      throw new Error(`makeScratchRepo: git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    }
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=verify-tauri', '-c', 'user.email=verify-tauri@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

/** The scratch worktree a Session's creation leaves next to the scratch repo (`git/worktrees.rs`:
 * `<repo>/../pinion-worktrees/<repoName>/<name>`) -- deleted alongside the repo itself in
 * `safeRmSync` cleanup (gate-fix, security review LOW: this was previously left behind on every
 * US4 run since only `repoDir` itself was ever removed). */
function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

/** Builds the Rust app once with no dev server (the live-run convention, 2026-10-13): `tauri
 * build --debug --no-bundle` runs the renderer's own production build plus `cargo build`
 * (never `cargo run`), so it never touches Vite's shared port 5174 and finishes with a plain
 * exe under `CARGO_TARGET_DIR` (or cargo's own default when that is unset), not a running
 * process. Takes a few minutes the first time; a shared target dir makes a rebuild fast once
 * most crates are already compiled. */
function buildTauriDebugNoBundle() {
  // A shared `CARGO_TARGET_DIR` means another lane's own running exe (built from the same
  // crate) can transiently hold `debug/refract-tauri.exe` open, so `cargo build`'s own rename-
  // over-the-old-binary step fails with "Access is denied" until that lane's process exits.
  // Retried, not treated as this run's own failure.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const env = { ...process.env };
    if (CARGO_TARGET_DIR) env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
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
    console.warn(`verify-tauri: build exe locked by another process (shared CARGO_TARGET_DIR), retrying in 30s (attempt ${attempt}/${maxAttempts})...`);
    spawnSync_('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
  }
}

/** Copies the just-built exe to its own scratch dir, so two lanes' own runs (and a later build
 * overwriting the shared target dir's own copy) never collide with a process already running. */
function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) {
    throw new Error(`copyBuiltExe: built exe not found at ${src} (CARGO_TARGET_DIR=${CARGO_TARGET_DIR ?? '(unset, using cargo default)'})`);
  }
  copyFileSync(src, dest);
  return dest;
}

/** Runs the already-built, already-copied exe directly via `launchTracked` -- no wrapper
 * process, so the pid this returns IS the app, and `stopProcess` can validate every descendant
 * (the exe's own WebView2 process tree) against this launch's own recorded creation time.
 * `WEBVIEW2_USER_DATA_FOLDER` (a documented WebView2 env var) gets its own scratch subfolder
 * next to the copied exe: WebView2's default user-data-folder resolution can collide across
 * concurrently running instances sharing an identity, surfacing as `HRESULT(0x8007139F)`
 * ("the group or resource is not in the correct state") -- seen live when another lane's own
 * Tauri instance was running at the same time. */
async function launchBuiltExe(exePath, { port, dataDir, pathPrepend, extraEnv = {}, logFile }) {
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
  const child = await launchTracked(exePath, [], { cwd: path.dirname(exePath), env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return child;
}

function withEvidenceDir(name) {
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

/** Polls `[aria-label="Transcript"]`'s own `textContent` until it both contains `finalToken` AND
 * has visibly changed at least once before settling on that final value -- proves the reply
 * actually streamed in over more than one render, not just a single final paint that would also
 * pass for a non-streaming implementation (gate-fix, tests review MEDIUM). Also fails loudly (not
 * silently) if a "prompt failed" notice appears, which a missing `response` ack to `prompt` would
 * otherwise cause (gate-fix, code review HIGH, fixed in the fixtures themselves). */
async function waitForStreamedReply(cdp, { finalToken, timeoutMs = 60_000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  const distinctValues = new Set();
  let lastValue = '';
  while (Date.now() < deadline) {
    const { text, failedNotice } = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); const text = t ? t.textContent : ''; return { text, failedNotice: /prompt failed/i.test(text) }; })()`,
    );
    if (failedNotice) {
      throw new Error(`waitForStreamedReply: a "prompt failed" notice appeared in the transcript (missing response ack to prompt?): ${text}`);
    }
    if (text !== lastValue) {
      distinctValues.add(text);
      lastValue = text;
    }
    if (text.trim().endsWith(finalToken) && distinctValues.size > 1) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitForStreamedReply: timed out after ${timeoutMs}ms waiting for a streamed reply ending in "${finalToken}" (${distinctValues.size} distinct transcript state(s) seen; last: ${JSON.stringify(lastValue)})`,
  );
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
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed after Create session' });

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
    await waitForStreamedReply(cdp, { finalToken: REPLY_TOKEN, timeoutMs: 60_000 });
  } catch (err) {
    const text = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.textContent ?? '(no Transcript element)'`);
    console.error('verify-tauri: streamed reply never matched; transcript textContent:', JSON.stringify(text));
    await cdp.screenshot(path.join(evidenceDir, 'us4-04-diag-failure.png'));
    throw err;
  }
  await cdp.screenshot(path.join(evidenceDir, 'us4-04-streamed-reply.png'));
  console.log('US4 PASS: message sent, approval answered, and a genuinely streamed reply (more than one transcript state observed) read back from the transcript DOM.');
}

async function runFakeOmpProof() {
  let shimDir, dataDir, repoDir, exeDir, evidenceDir;
  let child;
  let cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-data-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-r12a-repo-')));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-exe-'));
    evidenceDir = withEvidenceDir('fake-omp');
    const port = await getFreePort();

    console.log(`verify-tauri: shim dir ${shimDir}`);
    console.log(`verify-tauri: data dir ${dataDir}`);
    console.log(`verify-tauri: repo dir ${repoDir}`);
    console.log(`verify-tauri: evidence dir ${evidenceDir}`);
    console.log(`verify-tauri: CDP port ${port}`);

    buildOmpShim(shimDir);
    console.log('verify-tauri: building (tauri build --debug --no-bundle, no dev server)...');
    buildTauriDebugNoBundle();
    const exePath = copyBuiltExe(exeDir);
    console.log(`verify-tauri: built exe copied to ${exePath}`);

    child = await launchBuiltExe(exePath, {
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

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    // Belt-and-braces (gate-fix, security review MEDIUM): `getFreePort()` already removes the
    // usual collision window, but confirms the attached target's own process is genuinely a
    // descendant of `child`, not some other instance that raced onto the same port between the
    // free-port check and this connect.
    if (!isPortOwnedBy(port, child)) {
      throw new Error(`verify-tauri: CDP target on port ${port} is not a descendant of the process this run launched (pid ${child.pid}) -- refusing to drive it`);
    }
    await proveUs1(cdp, evidenceDir);
    await proveUs4(cdp, evidenceDir, { repoDir, message: `Reply with the single word ${REPLY_TOKEN}` });
    console.log(`verify-tauri: PASS (fake omp). Evidence: ${evidenceDir}`);
  } finally {
    cdp?.close();
    if (child) await stopProcess(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
  }
}

/** The one real-omp proof: US1 only, no model turn (ipc/readiness.rs never calls `prompt`). */
async function runRealOmpProof() {
  let dataDir, exeDir, evidenceDir;
  let child;
  let cdp;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-real-data-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-r12a-real-exe-'));
    evidenceDir = withEvidenceDir('real-omp');
    const port = await getFreePort();

    console.log(`verify-tauri: data dir ${dataDir}`);
    console.log(`verify-tauri: evidence dir ${evidenceDir}`);
    console.log(`verify-tauri: CDP port ${port}`);

    console.log('verify-tauri: building (tauri build --debug --no-bundle, no dev server)...');
    buildTauriDebugNoBundle();
    const exePath = copyBuiltExe(exeDir);
    console.log(`verify-tauri: built exe copied to ${exePath}`);

    child = await launchBuiltExe(exePath, { port, dataDir, logFile: path.join(evidenceDir, 'app.log') });

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isPortOwnedBy(port, child)) {
      throw new Error(`verify-tauri: CDP target on port ${port} is not a descendant of the process this run launched (pid ${child.pid}) -- refusing to drive it`);
    }
    await proveUs1(cdp, evidenceDir);
    const omp = await cdp.evaluate(`document.body.innerText`);
    writeFileSync(path.join(evidenceDir, 'us1-page-text.txt'), omp);
    console.log(`verify-tauri: PASS (real omp, US1 only). Evidence: ${evidenceDir}`);
  } finally {
    cdp?.close();
    if (child) await stopProcess(child);
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
