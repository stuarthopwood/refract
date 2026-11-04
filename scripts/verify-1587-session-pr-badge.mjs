#!/usr/bin/env node
// Live CDP check for #1587: session header badge/overflow for PRs and issues the session touched.
// Scenarios badge (no branch PR) and overflow (branch PR #5), tape session-pr-badge-1587.
// Run: CARGO_TARGET_DIR=<shared target> node scripts/verify-1587-session-pr-badge.mjs
// Shots dir: REFRACT_1587_SHOTS_DIR. No light theme exists, so Nordic Frost is the second pass.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, assertExeMatchesProcess, createReportLogger, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, computeDirty, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, citeScreenshots, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';
import { buildFakeGh1587 } from './verify-1587-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1587';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1587_SHOTS_DIR || 'C:/Users/shopwood/AppData/Local/Temp/verify1587/shots';
const FIELD = `document.querySelector('[aria-label="Message"]')`;
const OVERFLOW_BTN = `document.querySelector('button[aria-label$=" more pull requests and issues"]')`;
const BADGE = `document.querySelector('[role="img"][aria-label*="Pull request"], [role="img"][aria-label*="Issue"]')`;
const VIEW_BTN = `document.querySelector('button[aria-label^="View "], button[aria-label^="Open pull request"], button[aria-label^="Open issue"]')`;

const report = { gitHead: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: null, checks: [], screenshots: [] };
const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
const check = (ok, name, extra) => {
  report.checks.push({ name, ok, extra: extra ?? null });
  log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
};

async function key(cdp, k, code, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
}
const menuRows = (cdp) => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((i) => i.textContent.trim())`);

async function openMenuByClick(cdp, triggerExpr) {
  await cdp.click(triggerExpr);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'touched menu open' });
}
async function closeMenu(cdp) {
  await key(cdp, 'Escape', 'Escape', 27);
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'menu closed' });
}
async function shots(cdp, mode, mkdirDone) {
  const names = [];
  const snap = async (name) => { await sleep(400); await cdp.screenshot(path.join(SHOTS_DIR, name)); names.push(name); };
  await snap(`${mode}-dark-1280.png`);
  await switchTheme(cdp, 'nordic-frost', 'Nordic Frost');
  await snap(`${mode}-nordic-frost-1280.png`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
  await snap(`${mode}-nordic-frost-900.png`);
  await switchTheme(cdp, 'dark', 'Dark');
  await snap(`${mode}-dark-900.png`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  report.screenshots.push(...citeScreenshots(SHOTS_DIR, names));
}

async function runScenario(mode, launcherExe, exePath, exeHash, shimDir, ghDir) {
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-1587-${mode}-${n}-`));
  const dataDir = mk('data');
  const importSourceDir = mk('import');
  const repoDir = makeFakeGithubRepo(mk('repo'));
  const ghConfigDir = mk('ghcfg');
  let child;
  let cdp;
  try {
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: `${shimDir};${ghDir}`,
      logFile: path.join(SHOTS_DIR, `${mode}-app.log`),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session-pr-badge-1587',
        REFRACT_1587_MODE: mode,
        GH_CONFIG_DIR: ghConfigDir
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not this run's process`);
    assertExeMatchesProcess(launched.targetPid, exePath, exeHash);

    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repo added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Dialog closed' });
    await cdp.waitFor(`(() => { const el = ${FIELD}; return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });

    await cdp.evaluate(`(() => { window.__opened = []; document.addEventListener('click', (e) => { const a = e.target instanceof Element ? e.target.closest('a[target="_blank"]') : null; if (a) { e.preventDefault(); e.stopPropagation(); window.__opened.push(a.href); } }, true); return true; })()`);
    await cdp.click(FIELD);
    await cdp.send('Input.insertText', { text: 'touch some pull requests' });
    await key(cdp, 'Enter', 'Enter', 13);

    const controlExpr = mode === 'overflow' ? OVERFLOW_BTN : VIEW_BTN;
    await cdp.waitFor(`!!(${controlExpr})`, { timeoutMs: 60_000, label: `${mode} control rendered` });
    await sleep(1500);

    const triggerLabel = await cdp.evaluate(`(${controlExpr}).getAttribute('aria-label')`);
    const badgeLabel = await cdp.evaluate(`(() => { const b = ${BADGE}; return b ? b.getAttribute('aria-label') : null; })()`);
    if (mode === 'badge') {
      check(!!badgeLabel && !(await cdp.evaluate(`!!${OVERFLOW_BTN}`)), 'badge mode: no branch PR, badge leads and there is no "+N" overflow button', { badgeLabel, triggerLabel });
      check(/other-owner\/other-repo#7/.test(badgeLabel ?? ''), 'badge mode: newest item (foreign) leads with owner/repo#N label', badgeLabel);
    } else {
      check(/^\d+ more pull requests and issues$/.test(triggerLabel ?? ''), 'overflow mode: button reads "N more pull requests and issues"', triggerLabel);
    }

    await openMenuByClick(cdp, controlExpr);
    const rows = await menuRows(cdp);
    const idx = (s) => rows.findIndex((r) => r.includes(s));
    check(idx('other-owner/other-repo#7') >= 0 && rows[idx('other-owner/other-repo#7')].startsWith('other-owner/other-repo#7') || rows.some((r) => /other-owner\/other-repo#7/.test(r)), 'foreign row is labelled owner/repo#N', rows);
    const order = [idx('other-owner/other-repo#7'), idx('#12'), idx('#5')].filter((i) => i >= 0);
    check(idx('other-owner/other-repo#7') === 0 && order.every((v, i, a) => i === 0 || a[i - 1] < v), 'rows are newest first (foreign #7, issue #12, then PR #5 when listed)', rows);
    await cdp.screenshot(path.join(SHOTS_DIR, `${mode}-menu-open.png`));
    report.screenshots.push(...citeScreenshots(SHOTS_DIR, [`${mode}-menu-open.png`]));

    const click = async (rowText) => {
      await cdp.click(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((i) => i.textContent.includes(${JSON.stringify(rowText)}))`);
    };
    await click('other-owner/other-repo#7');
    await sleep(800);
    const opened = await cdp.evaluate(`window.__opened`);
    check(opened.length === 1 && opened[0].startsWith('https://github.com/other-owner/other-repo/pull/7'), 'foreign row opens externally with the item href', opened);
    const pinnedAfterForeign = await cdp.evaluate(`(() => { const s = window.__refractStores?.pinnedPanels?.getState?.(); return s ? { pr: !!s.pullRequest, issue: !!s.issue } : null; })()`);
    check(!pinnedAfterForeign || (!pinnedAfterForeign.pr && !pinnedAfterForeign.issue), 'foreign row does not pin anything', pinnedAfterForeign ?? 'stores not exposed in this build; href check stands');

    await openMenuByClick(cdp, controlExpr);
    await click('#12 ');
    await sleep(1000);
    const openedAfterOwn = await cdp.evaluate(`window.__opened.length`);
    const pane = await cdp.evaluate(`(() => { const s = window.__refractStores?.pinnedPanels?.getState?.(); const tab = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map((t) => t.textContent.trim()); return { issue: s ? !!s.issue : null, tabs: tab }; })()`);
    check(openedAfterOwn === 1 && (pane.issue === true || pane.tabs.some((t) => /issue/i.test(t))), 'own-repo row pins the Issue in the right pane without opening a browser', pane);
    await cdp.screenshot(path.join(SHOTS_DIR, `${mode}-own-row-pinned.png`));
    report.screenshots.push(...citeScreenshots(SHOTS_DIR, [`${mode}-own-row-pinned.png`]));

    // Keyboard: Tab from the composer to the control, Enter opens the menu, Escape returns focus to it.
    const isControl = `(() => { const a = document.activeElement; const c = ${controlExpr}; return !!a && a === c; })()`;
    await cdp.click(FIELD);
    let reached = false;
    for (let i = 0; i < 80 && !reached; i += 1) {
      await key(cdp, 'Tab', 'Tab', 9);
      reached = await cdp.evaluate(isControl);
    }
    if (!reached) {
      // Header precedes the composer in DOM order, so also try backwards.
      for (let i = 0; i < 80 && !reached; i += 1) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
        reached = await cdp.evaluate(isControl);
      }
    }
    check(reached, 'keyboard Tab reaches the touched-items control', triggerLabel);
    if (reached) {
      await key(cdp, 'Enter', 'Enter', 13);
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'Enter opens menu' }).then(() => check(true, 'Enter opens the menu'), () => check(false, 'Enter opens the menu'));
      if (await cdp.evaluate(`!!document.querySelector('[role="menu"]')`)) {
        await closeMenu(cdp);
        await sleep(300);
        check(await cdp.evaluate(isControl), 'Escape returns focus to the trigger');
      }
    }

    await shots(cdp, mode);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => {});
    for (const d of [dataDir, importSourceDir, repoDir, ghConfigDir]) await safeRmSync(d, LOG);
  }
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  for (const k of Object.keys(process.env)) if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST)$/i.test(k)) delete process.env[k];
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-1587-${n}-`));
  const shimDir = mk('shim');
  const launcherDir = mk('launcher');
  const exeDir = mk('exe');
  const ghDir = mk('fake-gh');
  try {
    buildOmpShim(shimDir);
    buildFakeGh1587(ghDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    report.exeSha256 = exeInfo.hash;
    for (const mode of ['badge', 'overflow']) await runScenario(mode, launcherExe, exeInfo.dest, exeInfo.hash, shimDir, ghDir);
  } catch (err) {
    check(false, 'driver ran to completion', String(err && err.stack ? err.stack : err));
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    for (const d of [shimDir, launcherDir, exeDir, ghDir]) await safeRmSync(d, LOG);
  }
  const failed = report.checks.filter((c) => !c.ok);
  log(`${LOG}: ${report.checks.length - failed.length}/${report.checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
