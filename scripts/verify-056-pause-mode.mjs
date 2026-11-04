#!/usr/bin/env node
// Live CDP check for issue #477 (Pause mode, spec 056). Drives a REAL built Tauri debug exe over
// CDP against the FAKE `omp` shim (`pause-056` / `pause-056-reopen` scenarios), never a real
// `omp`, a real model or real GitHub. Scratch REFRACT_DATA_DIR under the OS temp dir.
//
// Usage (after `pnpm exec tauri build --debug --no-bundle` on this head, shared target dir set):
// CARGO_TARGET_DIR=<shared target dir> REFRACT_056_SHOTS_DIR=<dir> node scripts/verify-056-pause-mode.mjs

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { spawnSync_ } from './verify-1067-enter-queued-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-056';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_056_SHOTS_DIR || 'C:\\Users\\shopwood\\.copilot\\session-state\\012e6389-c8cb-47fc-add2-bf5a1619c740\\files';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADER_BTN = `Array.from(document.querySelectorAll('button[aria-label]')).find((b) => /^(Pause|Resume) (?!all$)/.test(b.getAttribute('aria-label')))`;
const FOOTER_BTN = (label) => `document.querySelector('button[aria-label="${label}"]')`;
const PAUSED_GROUP = `document.querySelector('[role="group"][aria-label="Session paused"]')`;
const BODY_INERT = `!!(${PAUSED_GROUP})?.previousElementSibling?.inert`;
const STATUS_TEXT = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-056-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-056-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-056-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-056-pause');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-056-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-056-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-056-shim-'));
  const convDir = mkdtempSync(path.join(tmpdir(), 'refract-056-conv-'));
  const conversationFile = path.join(convDir, 'conversation.json');
  writeFileSync(conversationFile, '{}');

  let child;
  let child2;
  let cdp;
  let cdp2;
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
          REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile
        }
      });
      const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
      const session = await CdpSession.connect(wsUrl);
      if (!isTargetOwningPort(port, launched.targetPid)) {
        throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
      }
      return { launched, session };
    };

    const first = await launch('pause-056', 'app.log');
    child = first.launched.child;
    cdp = first.session;
    const shot = (c, name) => c.screenshot(path.join(SHOTS_DIR, name));
    const settle = async (c) => {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      await sleep(400);
    };

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'hold the line' });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.body.innerText.includes('Working on it')`, { timeoutMs: 30_000, label: 'Turn streaming' });

    // 1. Pause mid-turn -> Pausing...
    const startLabel = await cdp.evaluate(`(${HEADER_BTN})?.getAttribute('aria-label') ?? null`);
    check(!!startLabel && startLabel.startsWith('Pause '), 'header shows a Pause button mid-turn', startLabel);
    await cdp.click(HEADER_BTN);
    let ok = await cdp.waitFor(STATUS_TEXT('Pausing…'), { timeoutMs: 10_000, label: 'Pausing shown' }).then(() => true, () => false);
    check(ok && !(await cdp.evaluate(`!!(${PAUSED_GROUP})`)), 'mid-turn Pause shows "Pausing…" and no overlay yet');
    await settle(cdp);
    await shot(cdp, '056-01-pausing.png');

    // 2. Turn ends -> Paused overlay, body inert.
    ok = await cdp.waitFor(`!!(${PAUSED_GROUP})`, { timeoutMs: 40_000, label: 'Paused overlay' }).then(() => true, () => false);
    const overlay = await cdp.evaluate(`(() => { const g = ${PAUSED_GROUP}; return { text: g ? g.innerText : null, inert: ${BODY_INERT}, resume: !!g && !!Array.from(g.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Resume') }; })()`);
    check(ok && overlay.inert && overlay.resume && /Paused/.test(overlay.text ?? '') && /Press\s+Space\s+or select Resume/.test(overlay.text ?? ''), 'turn end -> Paused overlay (text, Resume button) and inert body', overlay);
    await settle(cdp);
    await shot(cdp, '056-02-paused-overlay.png');

    // 3. Space (focus outside any field) resumes.
    await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    ok = await cdp.waitFor(    `!(${PAUSED_GROUP})`, { timeoutMs: 10_000, label: 'Resumed by Space' }).then(() => true, () => false);
        check(ok && !(await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.closest('[inert]') != null`)), 'Space resumes the paused session (overlay gone, body no longer inert)');
    await settle(cdp);
    await shot(cdp, '056-03-space-resumed.png');

    // 4. Row context menu -> Pause item -> pauses.
    const row = await cdp.waitFor(`(() => { const el = document.querySelector('[data-session-open]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, { timeoutMs: 10_000, label: 'session row' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'right', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'right', clickCount: 1 });
    const menuItems = () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((i) => i.textContent.trim())`);
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'row menu' }).catch(() => {});
    const items = await menuItems();
    check(items.includes('Pause'), 'row context menu offers Pause', items);
    await shot(cdp, '056-04-row-menu.png');
    await cdp.click(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((i) => i.textContent.trim() === 'Pause')`);
    ok = await cdp.waitFor(`!!(${PAUSED_GROUP})`, { timeoutMs: 10_000, label: 'Paused via row menu' }).then(() => true, () => false);
    check(ok, 'row menu Pause pauses an idle session straight to Paused');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });

    // 5. Resume via the row menu item, then Pause all / Resume all in the footer.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'right', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'right', clickCount: 1 });
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'row menu 2' }).catch(() => {});
    const items2 = await menuItems();
    check(items2.includes('Resume'), 'row context menu offers Resume while paused', items2);
    await cdp.click(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((i) => i.textContent.trim() === 'Resume')`);
    ok = await cdp.waitFor(`!(${PAUSED_GROUP})`, { timeoutMs: 10_000, label: 'Resumed via row menu' }).then(() => true, () => false);
    check(ok, 'row menu Resume resumes the session');
    await settle(cdp);
    const hasPauseAll = await cdp.waitFor(`!!(${FOOTER_BTN('Pause all')})`, { timeoutMs: 10_000, label: 'Pause all button' }).then(() => true, () => false);
    check(hasPauseAll, 'footer shows Pause all when nothing is paused');
    await shot(cdp, '056-05-pause-all.png');
    await cdp.click(FOOTER_BTN('Pause all'));
    ok = await cdp.waitFor(`!!(${PAUSED_GROUP}) && !!(${FOOTER_BTN('Resume all')})`, { timeoutMs: 10_000, label: 'All paused' }).then(() => true, () => false);
    check(ok, 'Pause all pauses the session and the footer flips to Resume all');
    await settle(cdp);
    await shot(cdp, '056-06-resume-all.png');
    await cdp.click(FOOTER_BTN('Resume all'));
    ok = await cdp.waitFor(`!(${PAUSED_GROUP}) && !!(${FOOTER_BTN('Pause all')})`, { timeoutMs: 10_000, label: 'All resumed' }).then(() => true, () => false);
    check(ok, 'Resume all resumes the session and the footer flips back to Pause all');

    // 6. Pause, restart on the same data dir, still Paused.
    await cdp.click(FOOTER_BTN('Pause all'));
    ok = await cdp.waitFor(`!!(${PAUSED_GROUP})`, { timeoutMs: 10_000, label: 'Paused before restart' }).then(() => true, () => false);
    check(ok, 'session paused before restart');
    await sleep(1500);
    cdp.close();
    cdp = undefined;
    const pids = [first.launched.targetPid, child && child.pid].filter(Boolean);
    for (const pid of pids) {
      const listing = spawnSync_('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object ProcessId,ExecutablePath | Format-List | Out-String`]);
      console.log(`${LOG}: stopping spawned pid ${pid}: ${listing.stdout.replace(/\s+/g, ' ').trim()}`);
    }
    await stopLauncher(child);
    child = undefined;
    await sleep(2000);

    const second = await launch('pause-056-reopen', 'app2.log');
    child2 = second.launched.child;
    cdp2 = second.session;
    await cdp2.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: session row rendered' });
    // The restart leaves no Session selected; open the row, which is still marked paused.
    await cdp2.waitFor(`!!(${FOOTER_BTN('Resume all')})`, { timeoutMs: 30_000, label: 'Relaunch: Resume all shown' });
    await cdp2.click(`document.querySelector('[data-session-open]')`);
    ok = await cdp2.waitFor(`!!(${PAUSED_GROUP})`, { timeoutMs: 30_000, label: 'Relaunch: Paused overlay' }).then(() => true, () => false);
    const persisted = await cdp2.evaluate(`({ overlay: !!(${PAUSED_GROUP}), inert: ${BODY_INERT}, resumeAll: !!(${FOOTER_BTN('Resume all')}) })`);
    check(ok && persisted.inert && persisted.resumeAll, 'after restart the session is still Paused (overlay, inert body, Resume all)', persisted);
    await settle(cdp2);
    await shot(cdp2, '056-07-persisted-after-restart.png');
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    try {
      if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '056-crash.png'));
      else if (cdp2) await cdp2.screenshot(path.join(SHOTS_DIR, '056-crash.png'));
    } catch { /* best effort */ }
    throw err;
  } finally {
    try {
      const failures = report.filter((r) => r.ok === false).map((r) => r.step);
      writeFileSync(path.join(SHOTS_DIR, '056-report.json'), JSON.stringify({ gitHead: head, dirty: dirtyLines.length > 0, failures, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (cdp2) cdp2.close();
    if (child) await stopLauncher(child).catch(() => {});
    if (child2) await stopLauncher(child2).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
    await safeRmSync(convDir, LOG);
  }

  const failed = report.filter((r) => r.ok === false);
  console.log(`${LOG}: ${report.length - failed.length}/${report.length} steps passed; evidence in ${SHOTS_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
