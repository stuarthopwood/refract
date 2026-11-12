#!/usr/bin/env node
// `pnpm verify:tauri`: CDP-driven proof (US1 readiness, US4 streamed chat) for the Tauri/WebView2 build.
// Runs a scratch copy of the debug exe: no dev server (Vite port 5174 is shared), and the shared target exe can be overwritten mid-run.
// `--real-omp` runs US1 only against a real `omp`; readiness never calls `prompt`, so no model turn is spent.
// Everything runs in the launcher's kill-on-close Job Object, never a kill by name or computed pid.
// `CARGO_TARGET_DIR` is required (#946): a worktree-local `src-tauri/target` has filled the disk before.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
// Independent of REPLY_TOKEN: otherwise the echoed prompt could satisfy a token check.
const PROMPT_MESSAGE = 'Please respond now.';
// A token the fake omp's assistant reply ends with; absent from `PROMPT_MESSAGE` above.
const REPLY_TOKEN = 'xyzzy9';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Windows handles from the stopped process tree may still be closing; EPERM/EBUSY must not mask the result.
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

// Bare `rustc` (no Cargo project) so it never touches the shared `CARGO_TARGET_DIR` lock.
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

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) {
    throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  }
  return out;
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

// Never seed a repo under C:/Repos/personal. Throws on git failure so it does not surface as a vague timeout later.
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

// Session creation leaves `<repo>/../pinion-worktrees/<repoName>/<name>`; cleanup must remove it too.
function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

// Windows cannot spawn the `pnpm.cmd` shim without a shell, so run the repo-local Tauri CLI's JS entry with this node: fixed path, no shell, no env-derived command.
const TAURI_CLI_ENTRY = path.join(REPO_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

// `tauri build --debug --no-bundle`, never `cargo run`, so Vite's shared port 5174 is untouched (#946).
function buildTauriDebugNoBundle() {
  // Another lane's running exe can hold `debug/refract-tauri.exe`, making cargo's rename fail with
  // "Access is denied"; retried rather than treated as this run's failure.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // The shared target dir's disk hit 100% once; CARGO_INCREMENTAL=0 keeps incremental artifacts small.
    const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR, CARGO_INCREMENTAL: '0' };
    const result = spawnSync_(process.execPath, [TAURI_CLI_ENTRY, 'build', '--debug', '--no-bundle'], {
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

// Own scratch dir so a later build overwriting the shared exe never collides with a running process.
function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) {
    throw new Error(`copyBuiltExe: built exe not found at ${src} (CARGO_TARGET_DIR=${process.env.CARGO_TARGET_DIR})`);
  }
  copyFileSync(src, dest);
  return dest;
}

// Own `WEBVIEW2_USER_DATA_FOLDER`: the default can collide across concurrent instances (HRESULT 0x8007139F).
// `child` is the launcher (for `stopLauncher`); `targetPid` is the app (for `isTargetOwningPort` only).
async function launchBuiltExe(launcherExe, exePath, { port, dataDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  // Without this a scratch REFRACT_DATA_DIR still reaches the real ~/.omp (token guard writes skip only when it is unset).
  const agentDir = path.join(path.dirname(exePath), 'omp-agent');
  mkdirSync(agentDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), 'target.pid');
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    PI_CODING_AGENT_DIR: agentDir,
    ...extraEnv,
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

function withEvidenceDir(name) {
  const dir = path.join(tmpdir(), `refract-tauri-verify-r12a-${name}-${nowStamp()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
      { timeoutMs: 60_000, label: 'US1: readiness checklist all green (Add project enabled)' },
    );
  } catch (err) {
    const text = await cdp.evaluate(`document.body.innerText`);
    console.error('verify-tauri: US1 readiness never went green; page text at failure:\n' + text);
    throw err;
  }
  await cdp.screenshot(path.join(evidenceDir, 'us1-02-readiness-green.png'));
  console.log('US1 PASS: window painted, readiness green, Add project enabled.');
}

// Requires an earlier poll to see a proper prefix of finalToken, proving this token streamed incrementally.
// The streaming message is always the transcript's tail, so the tail scopes to it; fails on a "prompt failed" notice.
async function waitForStreamedReply(cdp, { finalToken, timeoutMs = 60_000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  let sawPartialPrefix = false;
  let lastValue = '';
  while (Date.now() < deadline) {
    const { text, failedNotice } = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); const text = t ? t.textContent.trim() : ''; return { text, failedNotice: /prompt failed/i.test(text) }; })()`,
    );
    if (failedNotice) {
      throw new Error(`waitForStreamedReply: a "prompt failed" notice appeared in the transcript (missing response ack to prompt?): ${text}`);
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
    if (fullyArrived && sawPartialPrefix) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitForStreamedReply: timed out after ${timeoutMs}ms waiting for a streamed reply ending in "${finalToken}" (partial prefix observed: ${sawPartialPrefix}; last: ${JSON.stringify(lastValue)})`,
  );
}

async function proveUs4(cdp, evidenceDir, { repoDir, message }) {
  await addRepository(cdp, repoDir);
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
    const launcherExe = buildLauncher(shimDir);
    console.log('verify-tauri: building (tauri build --debug --no-bundle, no dev server)...');
    buildTauriDebugNoBundle();
    const exePath = copyBuiltExe(exeDir);
    console.log(`verify-tauri: built exe copied to ${exePath}`);

    const launched = await launchBuiltExe(launcherExe, exePath, {
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
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    // Confirms the port's listener is this run's app, not another instance that raced onto the port.
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-tauri: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
    }
    await proveUs1(cdp, evidenceDir);
    await proveUs4(cdp, evidenceDir, { repoDir, message: PROMPT_MESSAGE });
    console.log(`verify-tauri: PASS (fake omp). Evidence: ${evidenceDir}`);
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
  }
}

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

    const launcherExe = buildLauncher(exeDir);
    console.log('verify-tauri: building (tauri build --debug --no-bundle, no dev server)...');
    buildTauriDebugNoBundle();
    const exePath = copyBuiltExe(exeDir);
    console.log(`verify-tauri: built exe copied to ${exePath}`);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, logFile: path.join(evidenceDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-tauri: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
    }
    await proveUs1(cdp, evidenceDir);
    const omp = await cdp.evaluate(`document.body.innerText`);
    writeFileSync(path.join(evidenceDir, 'us1-page-text.txt'), omp);
    console.log(`verify-tauri: PASS (real omp, US1 only). Evidence: ${evidenceDir}`);
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
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
