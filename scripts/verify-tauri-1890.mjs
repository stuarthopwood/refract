#!/usr/bin/env node
// Live CDP check for issue #1890 (spec 056): Resume starts a stopped paused Session and sends its held message;
// Stop idle skips paused Sessions. Drives a REAL built debug exe over CDP against the FAKE `omp` shim, never a
// real omp. Scratch REFRACT_DATA_DIR under the OS temp dir.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1890_SHOTS_DIR=<dir> node scripts/verify-tauri-1890.mjs

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1890';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1890_SHOTS_DIR || 'C:\\Users\\shopwood\\refract-live-check-1890';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADER_BTN = `Array.from(document.querySelectorAll('button[aria-label]')).find((b) => /^(Pause|Resume) (?!all$)/.test(b.getAttribute('aria-label')))`;
const PAUSED_GROUP = `document.querySelector('[role="group"][aria-label="Session paused"]')`;
const STATUS_TEXT = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };
  const yes = (p) => p.then(() => true, () => false);

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1890-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1890-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1890-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1890-pause');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1890-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1890-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1890-shim-'));
  const convDir = mkdtempSync(path.join(tmpdir(), 'refract-1890-conv-'));
  const conversationFile = path.join(convDir, 'conversation.json');
  writeFileSync(conversationFile, '{}');

  let child, child2, cdp, cdp2;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const launch = async (scenario, logName) => {
      const port = await getFreePort();
      const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
        port,
        dataDir,
        pathPrepend: shimDir,
        logFile: path.join(exeDir, logName),
        extraEnv: {
          REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
          REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
          REFRACT_FAKE_OMP_NODE: process.execPath,
          REFRACT_FAKE_OMP_SCENARIO: scenario,
          REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile,
          REFRACT_FORCE_LOW_MEMORY: '1'
        }
      });
      const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
      const session = await CdpSession.connect(wsUrl);
      if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target not owned by launched pid`);
      return { launched, session };
    };
    const shot = (c, name) => c.screenshot(path.join(SHOTS_DIR, name));
    const settle = async (c) => {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      await sleep(400);
    };

    const first = await launch('pause-056', 'app.log');
    child = first.launched.child;
    cdp = first.session;
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repo added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 60_000, label: 'Dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'hold the line' });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(STATUS_TEXT('Working on it'), { timeoutMs: 30_000, label: 'Turn streaming' });

    // Pause mid-turn and queue a message while "Pausing…" (the composer is inert once Paused), then let the turn end.
    await cdp.click(HEADER_BTN);
    // The fake agent does not answer get_subagents during its 12 s hold, so "Pausing" appears only after that 10 s request times out.
    let ok = await yes(cdp.waitFor(`/pausing/i.test(document.body.innerText)`, { timeoutMs: 30_000, label: 'Pausing shown' }));
    check(ok, 'mid-turn Pause shows a Pausing state', { text: String(await cdp.evaluate(`document.body.innerText.slice(0, 600)`)) });
    await shot(cdp, '1890-00-pausing.png');
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'held message' });
    await cdp.clickByLabel('Send message');
    ok = await yes(cdp.waitFor(STATUS_TEXT('held message'), { timeoutMs: 10_000, label: 'Held chip' }));
    check(ok, 'a message sent while pausing shows as held');
    ok = await yes(cdp.waitFor(`!!(${PAUSED_GROUP})`, { timeoutMs: 40_000, label: 'Paused overlay' }));
    check(ok, 'turn end -> Paused overlay');
    await settle(cdp);
    await shot(cdp, '1890-01-paused-idle.png');

    // Stop idle skips the paused Session and says so.
    await cdp.waitFor(`!!document.querySelector('[aria-label="Open memory triage"]')`, { timeoutMs: 30_000, label: 'Low memory row' });
    await cdp.click(`document.querySelector('[aria-label="Open memory triage"]')`);
    ok = await yes(cdp.waitFor(STATUS_TEXT('Skipped 1 paused Session'), { timeoutMs: 10_000, label: 'Skipped line' }));
    const stopIdleEnabled = await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((x) => x.textContent.trim() === 'Stop idle'); return b ? !b.disabled : false; })()`);
    check(ok && !stopIdleEnabled, 'Stop idle dialog shows "Skipped 1 paused Session." and nothing to stop', { stopIdleEnabled });
    await shot(cdp, '1890-02-stop-idle-skipped.png');
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
    await shot(cdp, '1890-03-held-message.png');

    // Restart: the agent is gone, the Session is stopped and still paused.
    await sleep(1500);
    cdp.close();
    cdp = undefined;
    await stopLauncher(child);
    child = undefined;
    await sleep(2000);

    const second = await launch('pause-1890-reopen', 'app2.log');
    child2 = second.launched.child;
    cdp2 = second.session;
    await cdp2.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: row' });
    await cdp2.click(`document.querySelector('[data-session-open]')`);
    ok = await yes(cdp2.waitFor(`!!(${PAUSED_GROUP})`, { timeoutMs: 30_000, label: 'Relaunch: Paused overlay' }));
    const resumeBtn = `Array.from(document.querySelectorAll('[role="group"][aria-label="Session paused"] button')).filter((b) => b.textContent.trim() === 'Resume')`;
    const counts = await cdp2.evaluate(`({ resume: ${resumeBtn}.length, startAgent: !!${PAUSED_GROUP}.innerText.includes('Start agent') })`);
    check(ok && counts.resume === 1 && !counts.startAgent, 'stopped paused Session shows one Resume and no Start agent', counts);
    await settle(cdp2);
    await shot(cdp2, '1890-04-stopped-paused.png');

    await cdp2.click(`${resumeBtn}[0]`);
    ok = await yes(cdp2.waitFor(STATUS_TEXT('RESUMED-1890'), { timeoutMs: 60_000, label: 'Held message answered' }));
    check(ok, 'Resume started the agent and the held message went out (agent replied RESUMED-1890)');
    ok = await yes(cdp2.waitFor(`!(${PAUSED_GROUP})`, { timeoutMs: 30_000, label: 'Overlay gone' }));
    check(ok, 'pause cleared after the held message was sent');
    await settle(cdp2);
    await shot(cdp2, '1890-05-resumed.png');
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    try {
      const c = cdp ?? cdp2;
      if (c) await c.screenshot(path.join(SHOTS_DIR, '1890-crash.png'));
    } catch { /* best effort */ }
    throw err;
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, '1890-report.json'), JSON.stringify({ gitHead: head, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (cdp2) cdp2.close();
    if (child) await stopLauncher(child).catch(() => {});
    if (child2) await stopLauncher(child2).catch(() => {});
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir, convDir]) await safeRmSync(dir, LOG);
  }
  const failed = report.filter((r) => r.ok === false);
  console.log(`${LOG}: ${report.length - failed.length}/${report.length} steps passed; evidence in ${SHOTS_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
