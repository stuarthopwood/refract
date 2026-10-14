#!/usr/bin/env node
// Side chat (`/btw`) + word prediction live check for lane R6 (issue #789), against #789's own
// acceptance list. Driven directly through `window.refract.*` (never DOM clicks through the
// composer/side-chat panel -- faster and more robust than guessing selectors, and exercises the
// exact same Tauri IPC bridge the real UI calls). Reuses `scripts/verify-tauri-cdp.mjs`'s CDP
// primitives (issue #795, R12a) and duplicates the small build/copy/launch glue
// `scripts/verify-tauri.mjs` already has (never imported: that file is issue #795's own, and
// R6 selecting `side-chat-live.jsonl`/`side-chat-restart.jsonl` directly, instead of through
// `pnpm verify:tauri`, is exactly what `scripts/fixtures/omp-frames/README.md`'s own
// "Scenario selection" section calls for).
//
// Two launches against the recorded-frame fake `omp` (scripts/verify-tauri-fake-omp.mjs):
//   Run 1 (side-chat-live.jsonl): two scratch repositories, two Sessions (`live`, `peer`) plus a
//     third Session created but never opened (`stopped`). Proves: a side question streams during
//     a main turn and finishes; a second side question is cancelled and the cancelled record
//     carries no leftover text; the peer Session's own side-chat:patch listener sees nothing the
//     whole run (cross-session isolation); ghost text (`predict_word`) is gated off by default
//     (no RPC at all) until the switch is flipped, then works; the off switch's own gate never
//     reaches a never-opened Session's process; a Conversation switch raises
//     `side-chat:conversation-changed`.
//   Run 2 (side-chat-restart.jsonl): a fresh launch against the SAME `REFRACT_DATA_DIR`, a brand
//     new fake `omp` process reattaching to the `live` Session, proving `sideChat.getHistory`
//     survives a restart (see that fixture's own provenance note for what this does and does not
//     prove with no real `omp` in the loop).
//
// Not covered here (left "not exercised" per the lane's own verification instructions): a real,
// signed-in `omp`'s actual on-disk `btw` history persistence (no live model turn was spent on
// this lane; `side-chat-restart.jsonl` simulates the reattach shape only), and real WebView2
// ghost-text UI interaction (MessageInput.tsx's own debounce/caret math) -- `predict_word` is
// called directly here, the same contract the composer itself calls.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-tauri-side-chat: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function buildTauriDebugNoBundle() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const env = { ...process.env };
    if (CARGO_TARGET_DIR) {
      env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
      env.CARGO_INCREMENTAL = '0';
    }
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
    console.warn(`verify-tauri-side-chat: build exe locked, retrying in 30s (attempt ${attempt}/${maxAttempts})...`);
    spawnSync_('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
  }
}

function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyBuiltExe: built exe not found at ${src}`);
  copyFileSync(src, dest);
  return dest;
}

async function launchBuiltExe(launcherExe, exePath, { port, dataDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${nowStamp()}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${nowStamp()}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
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
  const dir = path.join(tmpdir(), `refract-tauri-verify-r6-${name}-${nowStamp()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=verify-tauri-side-chat', '-c', 'user.email=verify-tauri-side-chat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-side-chat: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

function countLines(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0).length;
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Creates a repository + Session, opens it (attaches the fake `omp` process), and returns the
 * new Session's own id. `open: false` creates it without ever attaching -- the "never starts a
 * stopped Session's process" check needs exactly that. */
async function createSession(cdp, repoDir, { open }) {
  const repo = await cdp.evaluate(`window.refract.repositories.add(${JSON.stringify(repoDir)}).then((r) => r.ok ? r.value : Promise.reject(new Error(JSON.stringify(r.error))))`);
  const session = await cdp.evaluate(
    `window.refract.sessions.create({ repositoryId: ${JSON.stringify(repo.id)}, baseBranch: 'main' }).then((r) => r.ok ? r.value : Promise.reject(new Error(JSON.stringify(r.error))))`,
  );
  if (open) {
    await cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(session.id)}).then((r) => r.ok ? null : Promise.reject(new Error(JSON.stringify(r.error))))`);
  }
  return session.id;
}

/** Installs a global side-chat event collector on `window` so assertions below can inspect every
 * payload any Session's listener received during the whole run, not just the most recent one. */
async function installEventCollectors(cdp) {
  await cdp.evaluate(`
    window.__r6Events = { patch: [], interrupted: [], conversationChanged: [] };
    window.refract.onSideChatPatch((p) => window.__r6Events.patch.push(p));
    window.refract.onSideChatInterrupted((p) => window.__r6Events.interrupted.push(p));
    window.refract.onSideChatConversationChanged((p) => window.__r6Events.conversationChanged.push(p));
    true;
  `);
}

async function runLiveChecks(cdp, evidenceDir, { repoLiveDir, repoPeerDir, repoStoppedDir, debugLogPath }) {
  await installEventCollectors(cdp);

  const liveId = await createSession(cdp, repoLiveDir, { open: true });
  const peerId = await createSession(cdp, repoPeerDir, { open: true });
  const stoppedId = await createSession(cdp, repoStoppedDir, { open: false });
  console.log(`verify-tauri-side-chat: live=${liveId} peer=${peerId} stopped=${stoppedId}`);

  // --- Acceptance 1: a side question streams during a main turn and finishes. ---
  const sendResult = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(liveId)}, 'Please respond now, r6.')`);
  assert(sendResult.ok, `chat.send failed: ${JSON.stringify(sendResult)}`);
  const askTopic1 = await cdp.evaluate(`window.refract.sideChat.ask(${JSON.stringify(liveId)}, 'Is this safe to run concurrently?')`);
  assert(askTopic1.ok, `sideChat.ask (topic 1) failed: ${JSON.stringify(askTopic1)}`);
  assert(askTopic1.value.record.status === 'running', `topic 1's immediate record should be running: ${JSON.stringify(askTopic1.value)}`);

  const topic1Complete = await waitFor(
    () => cdp.evaluate(`window.__r6Events.patch.some((p) => p.sessionId === ${JSON.stringify(liveId)} && p.record?.id === 'topic-1' && p.record?.status === 'complete')`),
    { timeoutMs: 15_000, label: 'topic-1 side-chat:patch reaches status complete' },
  );
  assert(topic1Complete, 'topic 1 never completed');
  console.log('PASS: side question streamed (delta patches observed) and completed while the main turn was still in flight.');

  // Let the main turn finish settling (its own get_state round trip) before the next topic.
  await waitFor(
    () => cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(liveId)})?.status === 'idle')`),
    { timeoutMs: 30_000, label: 'main turn settles back to idle' },
  );
  console.log('PASS: the main turn itself finished (streamed reply observed via session settling to idle).');

  // --- Acceptance 2: cancel stops it, no leftover text on the cancelled record. ---
  const askTopic2 = await cdp.evaluate(`window.refract.sideChat.ask(${JSON.stringify(liveId)}, 'Will this be cancelled?')`);
  assert(askTopic2.ok, `sideChat.ask (topic 2) failed: ${JSON.stringify(askTopic2)}`);
  const cancelResult = await cdp.evaluate(`window.refract.sideChat.cancel(${JSON.stringify(liveId)})`);
  assert(cancelResult.ok, `sideChat.cancel failed: ${JSON.stringify(cancelResult)}`);
  const topic2Cancelled = await waitFor(
    () => cdp.evaluate(`window.__r6Events.patch.find((p) => p.sessionId === ${JSON.stringify(liveId)} && p.record?.id === 'topic-2')`),
    { timeoutMs: 15_000, label: 'topic-2 side-chat:patch arrives' },
  );
  assert(topic2Cancelled.record.status === 'cancelled', `topic 2 should be cancelled: ${JSON.stringify(topic2Cancelled)}`);
  assert(!topic2Cancelled.record.answer, `a cancelled record must carry no leftover answer text: ${JSON.stringify(topic2Cancelled)}`);
  console.log('PASS: cancel stopped the second side question; its own record carries no leftover answer text.');

  // --- Acceptance 3: cross-session isolation -- the peer Session never saw anything. ---
  const peerLeakage = await cdp.evaluate(`window.__r6Events.patch.filter((p) => p.sessionId === ${JSON.stringify(peerId)}).length`);
  assert(peerLeakage === 0, `the peer Session's own side-chat:patch listener should see nothing, saw ${peerLeakage}`);
  console.log('PASS: the peer Session (never asked a side question) received zero side-chat:patch events all run -- no cross-session leakage.');

  // --- Acceptance 4 (off switch, #772): disabled by default, chat.predictWord never reaches OMP. ---
  const settingsBefore = await cdp.evaluate(`window.refract.settings.get()`);
  assert(settingsBefore.ok, `settings.get failed: ${JSON.stringify(settingsBefore)}`);
  assert(settingsBefore.value.wordPredictionEnabled === false, `word prediction must default to off, got ${settingsBefore.value.wordPredictionEnabled}`);
  const logLinesBeforeDisabledCall = countLines(debugLogPath);
  const predictWhileDisabled = await cdp.evaluate(`window.refract.chat.predictWord(${JSON.stringify(liveId)}, 'hello wor', 9)`);
  assert(predictWhileDisabled.ok && predictWhileDisabled.value === null, `predictWord while disabled should resolve ok:true value:null, got ${JSON.stringify(predictWhileDisabled)}`);
  await new Promise((r) => setTimeout(r, 500));
  const logLinesAfterDisabledCall = countLines(debugLogPath);
  assert(logLinesAfterDisabledCall === logLinesBeforeDisabledCall, 'predictWord while disabled must never reach the fake omp process at all (debug log grew)');
  console.log('PASS: off switch default is OFF, and chat.predictWord never sends predict_word at all while disabled.');

  // --- Acceptance 5: enabling the switch lets ghost text work on a LIVE Session. ---
  const enableResult = await cdp.evaluate(`window.refract.settings.setWordPredictionEnabled(true)`);
  assert(enableResult.ok, `settings.setWordPredictionEnabled(true) failed: ${JSON.stringify(enableResult)}`);
  const predictWhileEnabled = await cdp.evaluate(`window.refract.chat.predictWord(${JSON.stringify(liveId)}, 'hello wor', 9)`);
  assert(predictWhileEnabled.ok && predictWhileEnabled.value === 'ghost', `predictWord while enabled should resolve to the fixture's suffix "ghost", got ${JSON.stringify(predictWhileEnabled)}`);
  const feedbackResult = await cdp.evaluate(`window.refract.chat.predictWordFeedback(${JSON.stringify(liveId)}, 'hello wor', 9, 'ghost', true)`);
  assert(feedbackResult.ok, `predictWordFeedback failed: ${JSON.stringify(feedbackResult)}`);
  console.log('PASS: enabling the switch lets ghost text reach OMP and return a suggestion on the live Session; feedback round-trips too.');

  // --- Acceptance 6: ghost text never starts a stopped (never-opened) Session's process. ---
  const logLinesBeforeStoppedCall = countLines(debugLogPath);
  const predictOnStopped = await cdp.evaluate(`window.refract.chat.predictWord(${JSON.stringify(stoppedId)}, 'hello wor', 9)`);
  assert(predictOnStopped.ok && predictOnStopped.value === null, `predictWord on a never-opened Session should resolve ok:true value:null, got ${JSON.stringify(predictOnStopped)}`);
  await new Promise((r) => setTimeout(r, 500));
  const logLinesAfterStoppedCall = countLines(debugLogPath);
  assert(logLinesAfterStoppedCall === logLinesBeforeStoppedCall, 'predictWord on a never-opened Session must never spawn/invoke the fake omp process (debug log grew)');
  console.log('PASS: ghost text on a never-opened (stopped) Session degrades to null and never starts its process.');

  // --- Acceptance 7: a Conversation switch raises side-chat:conversation-changed. ---
  const beforeSwitch = await cdp.evaluate(`window.__r6Events.conversationChanged.length`);
  const switchResult = await cdp.evaluate(`window.refract.conversations.startNew(${JSON.stringify(liveId)})`);
  assert(switchResult.ok, `conversations.startNew failed: ${JSON.stringify(switchResult)}`);
  const switchEvent = await waitFor(
    () => cdp.evaluate(`window.__r6Events.conversationChanged.length > ${beforeSwitch} ? window.__r6Events.conversationChanged[window.__r6Events.conversationChanged.length - 1] : null`),
    { timeoutMs: 15_000, label: 'side-chat:conversation-changed fires after startNew' },
  );
  assert(switchEvent.sessionId === liveId, `conversation-changed should name the live Session: ${JSON.stringify(switchEvent)}`);
  console.log('PASS: starting a new Conversation raised side-chat:conversation-changed for the live Session.');

  writeFileSync(path.join(evidenceDir, 'r6-live-pass.txt'), 'all live-run acceptance checks passed\n');
  return { liveId, repoLiveDir };
}

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label} (last value: ${JSON.stringify(last)})`);
}

async function runRestartCheck(cdp, { liveId }) {
  const reopen = await cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(liveId)}, true)`);
  assert(reopen.ok, `sessions.open (reattach after restart) failed: ${JSON.stringify(reopen)}`);
  const history = await waitFor(
    () => cdp.evaluate(`window.refract.sideChat.getHistory(${JSON.stringify(liveId)})`),
    { timeoutMs: 20_000, label: 'sideChat.getHistory resolves after restart' },
  );
  assert(history.ok, `sideChat.getHistory after restart failed: ${JSON.stringify(history)}`);
  assert(history.value.length === 1 && history.value[0].id === 'topic-1', `expected exactly topic-1 in post-restart history, got ${JSON.stringify(history.value)}`);
  assert(history.value[0].answer === 'It stays internal to this module.', `post-restart history answer mismatch: ${JSON.stringify(history.value[0])}`);
  console.log('PASS: sideChat.getHistory reattached after a restart and returned the earlier topic (see side-chat-restart.jsonl provenance note for exact scope).');
}

async function main() {
  let shimDir, dataDir, repoLiveDir, repoPeerDir, repoStoppedDir, exeDir1, exeDir2, evidenceDir;
  let child1, child2;
  let cdp1, cdp2;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-r6-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-r6-data-'));
    repoLiveDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-r6-repo-live-')));
    repoPeerDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-r6-repo-peer-')));
    repoStoppedDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-r6-repo-stopped-')));
    exeDir1 = mkdtempSync(path.join(tmpdir(), 'refract-r6-exe1-'));
    exeDir2 = mkdtempSync(path.join(tmpdir(), 'refract-r6-exe2-'));
    evidenceDir = withEvidenceDir('side-chat');

    console.log(`verify-tauri-side-chat: data dir ${dataDir}`);
    console.log(`verify-tauri-side-chat: evidence dir ${evidenceDir}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    console.log('verify-tauri-side-chat: building (tauri build --debug --no-bundle)...');
    buildTauriDebugNoBundle();

    // ---- Run 1: side-chat-live.jsonl ----
    const exePath1 = copyBuiltExe(exeDir1);
    const port1 = await getFreePort();
    const debugLogPath = path.join(evidenceDir, 'fake-omp-invocations-run1.log');
    const launched1 = await launchBuiltExe(launcherExe, exePath1, {
      port: port1,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(evidenceDir, 'app-run1.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath,
        REFRACT_FAKE_OMP_SCENARIO: 'side-chat-live',
      },
    });
    child1 = launched1.child;
    cdp1 = await connectCdp(port1, launched1.targetPid);
    await cdp1.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp1.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'readiness green' },
    );
    const { liveId } = await runLiveChecks(cdp1, evidenceDir, { repoLiveDir, repoPeerDir, repoStoppedDir, debugLogPath });

    cdp1.close();
    cdp1 = null;
    await stopLauncher(child1);
    child1 = null;
    console.log('verify-tauri-side-chat: run 1 PASS, relaunching for the restart check...');

    // ---- Run 2: side-chat-restart.jsonl, same dataDir, fresh process ----
    const exePath2 = copyBuiltExe(exeDir2);
    const port2 = await getFreePort();
    const launched2 = await launchBuiltExe(launcherExe, exePath2, {
      port: port2,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(evidenceDir, 'app-run2.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(evidenceDir, 'fake-omp-invocations-run2.log'),
        REFRACT_FAKE_OMP_SCENARIO: 'side-chat-restart',
      },
    });
    child2 = launched2.child;
    cdp2 = await connectCdp(port2, launched2.targetPid);
    await cdp2.waitFor(`!!window.refract`, { timeoutMs: 30_000, label: 'window.refract bridge ready after restart' });
    await runRestartCheck(cdp2, { liveId });

    console.log(`verify-tauri-side-chat: ALL PASS. Evidence: ${evidenceDir}`);
  } finally {
    cdp1?.close();
    cdp2?.close();
    if (child1) await stopLauncher(child1);
    if (child2) await stopLauncher(child2);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    for (const repoDir of [repoLiveDir, repoPeerDir, repoStoppedDir]) {
      if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
      await safeRmSync(repoDir);
    }
    await safeRmSync(exeDir1);
    await safeRmSync(exeDir2);
  }
}

main().catch((err) => {
  console.error('verify-tauri-side-chat: FAIL');
  console.error(err);
  process.exitCode = 1;
});
