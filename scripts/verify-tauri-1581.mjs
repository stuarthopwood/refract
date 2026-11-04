#!/usr/bin/env node
// Live CDP check for issue #1581 (Settings > Advanced > "Optimise token usage" + confirm dialog).
// Drives the built debug exe (scratch copy) with scratch data, a fake `omp` on PATH and a scratch
// OMP_PROFILE; no model turn, no network. Covers already-optimised, 1-row and many-row dialogs,
// success, forced write failure and retry, busy state, and the 720px header.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1581.mjs
// Env: REFRACT_1581_SHOTS_DIR overrides the screenshot/report directory.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, citeScreenshots } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1581';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1581_SHOTS_DIR || path.join(tmpdir(), 'refract-1581-shots');
const STORE_FILE = 'token-guard.json';
const RESET_ERROR = 'Could not reset the settings. Try again.';
const LONG_UNBROKEN = 'github-copilot/' + 'very-long-unbroken-model-identifier-'.repeat(4).slice(0, 170) + ':auto';

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}
const shot = async (cdp, name) => {
  await sleep(400);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
};

const DLG = `document.querySelector('[role="alertdialog"][data-state="open"]')`;
const OPTIMISE = `Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Optimise token usage')`;
const dlgButton = (text) => `Array.from((${DLG})?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
const CONFIRM = `Array.from((${DLG})?.querySelectorAll('button') ?? []).find((b) => /^(Reset \\d+ setting|Resetting)/.test(b.textContent.trim()))`;
const CANCEL = dlgButton('Cancel');

// The store's file is Refract's own; version 2 means no legacy-threshold migration runs.
const seedStore = (dataDir, overrides) =>
  writeFileSync(path.join(dataDir, STORE_FILE), JSON.stringify({ version: 2, overrides, read_limit_migrated: true, thresholds_reset_pending: false }, null, 2));
const readOverrides = (dataDir) => {
  const file = path.join(dataDir, STORE_FILE);
  if (!existsSync(file) || statSync(file).isDirectory()) return null;
  return JSON.parse(readFileSync(file, 'utf8')).overrides;
};

const ONE_ROW = { 'task.maxConcurrency': 12 };
const MANY_ROWS = {
  'compaction.modelThresholds': { [LONG_UNBROKEN]: '55%', 'openai/gpt-x': '60%' },
  'compaction.thresholdPercent': 45,
  'compaction.idleEnabled': false,
  'compaction.idleThresholdTokens': 150000,
  'compaction.idleTimeoutSeconds': 600,
  'compaction.methodOrder': ['shake', 'handoff', 'remote'],
  'snapcompact.toolResults': false,
  'snapcompact.systemPrompt': LONG_UNBROKEN,
  'task.softRequestBudget': 1234,
  'task.maxConcurrency': 12,
  'autolearn.autoContinue': true,
  'advisor.reviewMode': 'turn',
  'modelRoles.advisor': LONG_UNBROKEN,
  'grep.contextBefore': 3,
  'grep.contextAfter': 4,
  'read.defaultLimit': 500,
  'read.summarize.enabled': true,
  'todo.eager': 'always',
  'prewalk.enabled': true,
  'plan.defaultOnStartup': true,
  'tools.artifactSpillThreshold': 100,
  'tools.xdev': false
};

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    importSourceDir: env.importSourceDir,
    pathPrepend: env.shimDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: {
      OMP_PROFILE: 'verify-1581',
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'session'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

const navButton = (label) => `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;

/** Opens Settings > Advanced; a re-entry via Appearance remounts the section so the store reloads from disk. */
async function openAdvanced(cdp, { remount = false } = {}) {
  if (!(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`))) {
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  }
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  if (remount) {
    await cdp.click(navButton('Chat'));
    await cdp.waitFor(`Array.from(document.querySelectorAll('h2')).some((h) => h.textContent.trim() === 'Chat')`, { timeoutMs: 10_000, label: 'Chat section mounted' });
  }
  await cdp.click(navButton('Advanced'));
  await cdp.waitFor(`!!(${OPTIMISE})`, { timeoutMs: 15_000, label: 'Optimise token usage button mounted (story marker)' });
  await sleep(1000);
}

const buttonState = (cdp) =>
  cdp.evaluate(`(() => { const b = ${OPTIMISE}; return b ? { ariaDisabled: b.getAttribute('aria-disabled'), describedby: b.getAttribute('aria-describedby'), focused: document.activeElement === b } : null; })()`);

async function openDialog(cdp) {
  await cdp.click(OPTIMISE);
  await cdp.waitFor(`!!(${DLG})`, { timeoutMs: 5_000, label: 'Confirm dialog open' });
  await sleep(500);
}
async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
}
const waitDialogGone = (cdp, label) => cdp.waitFor(`!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 5_000, label });

const dialogFacts = (cdp) =>
  cdp.evaluate(`(() => {
    const d = ${DLG};
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const items = Array.from(d.querySelectorAll('li'));
    const confirm = ${CONFIRM};
    const cr = confirm ? confirm.getBoundingClientRect() : null;
    const body = d.querySelector('[role="group"]');
    return {
      viewport: [innerWidth, innerHeight],
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      rowCount: items.length,
      confirmLabel: confirm ? confirm.textContent.trim() : null,
      confirmInViewport: !!cr && cr.top >= 0 && cr.bottom <= innerHeight && cr.left >= 0 && cr.right <= innerWidth,
      dialogInViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      dialogHScroll: d.scrollWidth > d.clientWidth + 1,
      overflowingRows: items.filter((li) => li.scrollWidth > li.clientWidth + 1).length,
      rowsRightOfDialog: items.filter((li) => li.getBoundingClientRect().right > r.right + 1).length,
      bodyGroupLabel: body ? body.getAttribute('aria-label') : null,
      firstRow: items[0] ? items[0].textContent.trim() : null,
      text: d.innerText.slice(0, 2000)
    };
  })()`);

const headerFacts = (cdp) =>
  cdp.evaluate(`(() => {
    const h = Array.from(document.querySelectorAll('h2')).find((e) => e.textContent.trim() === 'Advanced');
    const b = ${OPTIMISE};
    if (!h || !b) return null;
    const hr = h.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      heading: [Math.round(hr.left), Math.round(hr.top), Math.round(hr.right), Math.round(hr.bottom)],
      button: [Math.round(br.left), Math.round(br.top), Math.round(br.right), Math.round(br.bottom)],
      buttonHeight: Math.round(br.height),
      sameRow: br.top < hr.bottom && br.bottom > hr.top,
      overlap: hr.right > br.left + 0.5 && br.top < hr.bottom && br.bottom > hr.top,
      buttonInViewport: br.right <= innerWidth && br.left >= 0,
      docHScroll: document.documentElement.scrollWidth > innerWidth + 1
    };
  })()`);

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1581-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1581-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1581-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1581-optimise');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1581-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1581-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1581-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const exeHash = sha256OfFile(exe);
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: exeHash } });
    console.log(`${LOG}: head ${gitHead(REPO_ROOT)} exe sha256 ${exeHash}`);

    session = await launch({ launcherExe, exe, dataDir, shimDir, importSourceDir });
    const { cdp } = session;
    // Isolation proof: the resolved data dir is the scratch dir (the store file appears there on first write).
    check(path.dirname(exe).startsWith(tmpdir()) && dataDir.startsWith(tmpdir()), 'Isolation: exe and data dir are scratch copies under the temp dir', { exe, dataDir });

    // First run: an empty profile shows Readiness; add the scratch repo so the Settings button exists.
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!!document.querySelector('[data-readiness-primary]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 30_000, label: 'Settings button' });

    // 1. Already optimised (no overrides): button inert, reason announced, no dialog.
    await openAdvanced(cdp);
    let state = await buttonState(cdp);
    check(state && state.ariaDisabled === 'true' && state.describedby === 'optimise-disabled-reason', 'Defaults: button is aria-disabled and described by the reason', state);
    const reason = await cdp.evaluate(`document.getElementById('optimise-disabled-reason')?.textContent.trim() ?? null`);
    check(reason === 'Already optimised: every setting is at its default.', 'Defaults: reason text present', reason);
    await cdp.click(OPTIMISE);
    await sleep(600);
    check((await cdp.evaluate(`!!(${DLG})`)) === false, 'Defaults: clicking the disabled button opens no dialog', null);
    const box = await cdp.evaluate(`(() => { const r = (${OPTIMISE}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="tooltip"]')).find((t) => t.textContent.includes('Already optimised'))`, { timeoutMs: 5_000, label: 'Already-optimised tooltip visible' }).catch((e) => check(false, 'Defaults: tooltip shows on hover', String(e.message)));
    await shot(cdp, '01-already-optimised.png');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 });

    // 2. One changed row.
    seedStore(dataDir, ONE_ROW);
    await openAdvanced(cdp, { remount: true });
    state = await buttonState(cdp);
    check(state && state.ariaDisabled === null, 'One row: button is enabled', state);
    await shot(cdp, '02-advanced-one-row-header.png');
    await openDialog(cdp);
    let facts = await dialogFacts(cdp);
    check(facts && facts.rowCount === 1 && facts.confirmLabel === 'Reset 1 setting', 'One row: dialog lists exactly 1 row and the singular confirm label', facts && { rowCount: facts.rowCount, confirmLabel: facts.confirmLabel });
    check(facts && /Maximum parallel subagents/.test(facts.firstRow) && /12/.test(facts.firstRow) && /6/.test(facts.firstRow), 'One row: the row names the setting with its current and default value', facts && facts.firstRow);
    check(facts && facts.dialogInViewport && facts.confirmInViewport && !facts.dialogHScroll, 'One row: dialog and confirm fit the viewport with no horizontal scroll', facts);
    check(facts && facts.bodyGroupLabel === 'Settings that will change', 'One row: list group is labelled for assistive tech', facts && facts.bodyGroupLabel);
    await shot(cdp, '03-dialog-one-row.png');
    await cdp.click(CANCEL);
    await waitDialogGone(cdp, 'One row: dialog closed by Cancel');
    state = await buttonState(cdp);
    check(state && state.focused === true, 'One row: focus returns to the Optimise button after Cancel', state);
    check(JSON.stringify(readOverrides(dataDir)) === JSON.stringify(ONE_ROW), 'One row: Cancel wrote nothing (overrides unchanged on disk)', readOverrides(dataDir));

    // 3. Many rows with long unbroken values; Escape closes and returns focus.
    seedStore(dataDir, MANY_ROWS);
    await openAdvanced(cdp, { remount: true });
    await openDialog(cdp);
    facts = await dialogFacts(cdp);
    check(facts && facts.rowCount >= 20 && facts.confirmLabel === `Reset ${facts.rowCount} settings`, 'Many rows: dialog lists every changed row and the plural confirm label matches the count', facts && { rowCount: facts.rowCount, confirmLabel: facts.confirmLabel });
    check(facts && facts.text.includes(LONG_UNBROKEN.slice(0, 40)), 'Many rows: the long unbroken value is rendered', facts && facts.text.slice(0, 300));
    check(facts && !facts.dialogHScroll && facts.overflowingRows === 0 && facts.rowsRightOfDialog === 0, 'Many rows: long values wrap, nothing overflows horizontally', facts);
    check(facts && facts.dialogInViewport && facts.confirmInViewport, 'Many rows: dialog and the confirm button stay inside the viewport', facts && { viewport: facts.viewport, rect: facts.rect, confirmInViewport: facts.confirmInViewport });
    await shot(cdp, '04-dialog-many-rows.png');
    await pressEscape(cdp);
    await waitDialogGone(cdp, 'Many rows: Escape closes the dialog');
    state = await buttonState(cdp);
    check(state && state.focused === true, 'Many rows: focus returns to the Optimise button after Escape', state);

    // 4. Settings header at ~720px (enabled state, then the dialog).
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
    const header = await headerFacts(cdp);
    check(header && header.sameRow && !header.overlap && header.buttonInViewport && !header.docHScroll && header.buttonHeight <= 40, 'Header at 720px: title and button share a row, no overlap, no horizontal scroll, button is one line', header);
    await shot(cdp, '05-header-720.png');
    await openDialog(cdp);
    facts = await dialogFacts(cdp);
    check(facts && facts.dialogInViewport && facts.confirmInViewport && !facts.dialogHScroll && facts.overflowingRows === 0, 'Dialog at 720px: fits, confirm reachable, no horizontal overflow', facts && { viewport: facts.viewport, rect: facts.rect, confirmInViewport: facts.confirmInViewport });
    await shot(cdp, '06-dialog-many-rows-720.png');
    await pressEscape(cdp);
    await waitDialogGone(cdp, '720: dialog closed');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(500);

    // 5. Success path: confirm resets everything in one write.
    await openDialog(cdp);
    await cdp.click(CONFIRM);
    await waitDialogGone(cdp, 'Success: dialog closes after the reset');
    await sleep(600);
    const afterSuccess = readOverrides(dataDir);
    check(afterSuccess !== null && Object.keys(afterSuccess).length === 0, 'Success: token-guard.json holds no overrides', afterSuccess);
    state = await buttonState(cdp);
    check(state && state.ariaDisabled === 'true', 'Success: button becomes "already optimised" once the store reloads', state);
    check(state && state.focused === true, 'Success: focus rests on the Optimise button', state);
    check((await cdp.evaluate(`!document.querySelector('p[role="alert"]')`)) === true, 'Success: no page-level error line', null);
    await shot(cdp, '07-after-success.png');

    // 6. Busy: resetAll held open from the page so the in-flight state is observable.
    seedStore(dataDir, MANY_ROWS);
    await openAdvanced(cdp, { remount: true });
    const patched = await cdp.evaluate(`(() => {
      const tg = window.refract.tokenGuard;
      const orig = tg.resetAll;
      window.__resetCalls = 0;
      window.__restoreReset = () => { tg.resetAll = orig; };
      tg.resetAll = () => { window.__resetCalls += 1; return new Promise((resolve) => { window.__releaseReset = () => resolve(orig.call(tg)); }); };
      return tg.resetAll !== orig;
    })()`);
    check(patched === true, 'Busy setup: resetAll hook installed on window.refract.tokenGuard', patched);
    await openDialog(cdp);
    await cdp.click(CONFIRM);
    await cdp.waitFor(`(() => { const b = ${CONFIRM}; return !!b && b.textContent.trim() === 'Resetting…'; })()`, { timeoutMs: 5_000, label: 'Busy: confirm label reads Resetting…' });
    const busy = await cdp.evaluate(`(() => {
      const d = ${DLG};
      const confirm = ${CONFIRM};
      const cancel = ${CANCEL};
      const status = Array.from(d.querySelectorAll('[role="status"]')).map((e) => e.textContent.trim());
      return { confirmAria: confirm.getAttribute('aria-disabled'), cancelAria: cancel.getAttribute('aria-disabled'), status, calls: window.__resetCalls };
    })()`);
    check(busy.confirmAria === 'true' && busy.cancelAria === 'true' && busy.status.includes('Resetting…') && busy.calls === 1, 'Busy: confirm and Cancel are aria-disabled, status announces Resetting…, one reset in flight', busy);
    await shot(cdp, '08-dialog-busy.png');
    await cdp.click(CONFIRM);
    await cdp.click(CANCEL);
    await pressEscape(cdp);
    await sleep(700);
    const stillBusy = await cdp.evaluate(`({ open: !!(${DLG}), calls: window.__resetCalls })`);
    check(stillBusy.open === true && stillBusy.calls === 1, 'Busy: a second confirm click, Cancel and Escape are all inert (dialog open, still one call)', stillBusy);
    await cdp.evaluate(`window.__releaseReset()`);
    await waitDialogGone(cdp, 'Busy: dialog closes once the reset resolves');
    await cdp.evaluate(`window.__restoreReset()`);
    const afterBusy = readOverrides(dataDir);
    check(afterBusy !== null && Object.keys(afterBusy).length === 0, 'Busy: the released reset wrote an empty overrides map', afterBusy);

    // 7. Forced failure: swap token-guard.json for a non-empty directory so the atomic rename fails.
    seedStore(dataDir, MANY_ROWS);
    await openAdvanced(cdp, { remount: true });
    const storePath = path.join(dataDir, STORE_FILE);
    const aside = path.join(dataDir, 'token-guard.seed.json');
    copyFileSync(storePath, aside);
    rmSync(storePath);
    mkdirSync(storePath);
    writeFileSync(path.join(storePath, 'blocker.txt'), 'blocks the rename');
    await openDialog(cdp);
    const labelBefore = (await dialogFacts(cdp)).confirmLabel;
    await cdp.click(CONFIRM);
    await cdp.waitFor(`((${DLG})?.innerText ?? '').includes(${JSON.stringify(RESET_ERROR)})`, { timeoutMs: 10_000, label: 'Failure: inline error shown in the dialog' });
    // The inline error grows the scrolling dialog, pushing the footer below the fold; scroll it back so Cancel is clickable.
    await cdp.evaluate(`(${CANCEL}).scrollIntoView({ block: 'end' })`);
    await sleep(500);
    const failed = await cdp.evaluate(`(() => {
      const d = ${DLG};
      const confirm = ${CONFIRM};
      const cancel = ${CANCEL};
      const live = Array.from(d.querySelectorAll('[role="alert"], [aria-live]')).map((e) => e.textContent.trim()).filter(Boolean);
      return { open: !!d, confirmLabel: confirm ? confirm.textContent.trim() : null, confirmAria: confirm?.getAttribute('aria-disabled') ?? null, cancelAria: cancel?.getAttribute('aria-disabled') ?? null, live, pageAlert: Array.from(document.querySelectorAll('[role="alert"]')).some((e) => !d.contains(e)) };
    })()`);
    check(failed.open && failed.confirmLabel === labelBefore && failed.confirmAria !== 'true' && failed.cancelAria !== 'true', 'Failure: dialog stays open, busy state cleared, confirm label restored and retryable', { failed, labelBefore });
    check(failed.live.some((t) => t.endsWith(RESET_ERROR)) && failed.pageAlert === false, 'Failure: error is announced in the dialog live region and the page-level error line is not left behind', failed.live);
    check(statSync(storePath).isDirectory(), 'Failure: nothing was written (store still blocked)', null);
    await shot(cdp, '09-dialog-failure.png');
    await cdp.click(CANCEL);
    await waitDialogGone(cdp, 'Failure: Cancel closes the dialog');
    await openDialog(cdp);
    const reopened = await cdp.evaluate(`!((${DLG})?.innerText ?? '').includes(${JSON.stringify(RESET_ERROR)})`);
    check(reopened === true, 'Failure: the error is cleared after Cancel and reopen', reopened);
    // Retry after the fault is repaired.
    rmSync(storePath, { recursive: true });
    copyFileSync(aside, storePath);
    await cdp.click(CONFIRM);
    await waitDialogGone(cdp, 'Retry: dialog closes after the repaired write');
    const afterRetry = readOverrides(dataDir);
    check(afterRetry !== null && Object.keys(afterRetry).length === 0, 'Retry: the reset succeeds once the store is writable', afterRetry);
    await sleep(500);
    await shot(cdp, '10-after-retry.png');
    report.push({ step: 'screenshots (sha256)', ok: true, evidence: citeScreenshots(SHOTS_DIR, shotNames) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
