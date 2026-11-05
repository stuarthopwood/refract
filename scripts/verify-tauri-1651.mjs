#!/usr/bin/env node
// Live CDP check for #1651: the Paused card has no border (keeps background, radius, shadow). Drives a REAL built
// Tauri debug exe against the FAKE `omp` shim; scratch REFRACT_DATA_DIR. Pauses an idle session via the row menu.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1651_SHOTS_DIR=<dir> node scripts/verify-tauri-1651.mjs

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1651';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1651_SHOTS_DIR || 'C:\\Users\\shopwood\\AppData\\Local\\Temp\\lane1651\\shots';
const PORT = 9251;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSED_GROUP = `document.querySelector('[role="group"][aria-label="Session paused"]')`;

async function main() {
  console.log(`${LOG}: git HEAD ${gitHead(REPO_ROOT)}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1651-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1651-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1651-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1651-pause');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1651-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1651-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1651-shim-'));
  const convDir = mkdtempSync(path.join(tmpdir(), 'refract-1651-conv-'));
  const conversationFile = path.join(convDir, 'conversation.json');
  writeFileSync(conversationFile, '{}');

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = process.env.REFRACT_1651_PORT ? Number(process.env.REFRACT_1651_PORT) : (await getFreePort()) || PORT;
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'pause-056',
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target not owned by launched pid`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Scratch repository added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog open' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });

    const row = await cdp.waitFor(`(() => { const el = document.querySelector('[data-session-open]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, { timeoutMs: 10_000, label: 'session row' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'right', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'right', clickCount: 1 });
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'row menu' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((i) => i.textContent.trim() === 'Pause')`);
    await cdp.waitFor(`!!(${PAUSED_GROUP})`, { timeoutMs: 15_000, label: 'Paused overlay' });

    for (const theme of [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }]) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      await sleep(500);
      const style = await cdp.evaluate(`(() => { const s = getComputedStyle(${PAUSED_GROUP}); return { border: ['Top', 'Right', 'Bottom', 'Left'].map((k) => s['border' + k + 'Width']), bg: s.backgroundColor, radius: s.borderRadius, shadow: s.boxShadow }; })()`);
      check(style.border.every((w) => w === '0px'), `${theme.name}: Paused card has no border`, style);
      check(style.bg !== 'rgba(0, 0, 0, 0)' && style.radius !== '0px' && style.shadow !== 'none', `${theme.name}: card keeps background, radius and shadow`, style);
      await cdp.screenshot(path.join(SHOTS_DIR, `1651-paused-${theme.id}.png`));
    }
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    try { if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '1651-crash.png')); } catch { /* best effort */ }
    throw err;
  } finally {
    try { writeFileSync(path.join(SHOTS_DIR, '1651-report.json'), JSON.stringify(report, null, 2)); } catch { /* best effort */ }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const d of [dataDir, importSourceDir, repoDirBase, worktreesRootForCleanup, exeDir, launcherDir, shimDir, convDir]) await safeRmSync(d, LOG);
  }
  const failed = report.filter((r) => r.ok === false);
  console.log(`${LOG}: ${report.length - failed.length}/${report.length} steps passed; shots in ${SHOTS_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
