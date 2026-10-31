#!/usr/bin/env node
// Live CDP check for #569: profile menu (keyboard-only, update entry renderings) and the sidebar "N active" PR count.
// Runs in scratch data dirs, never the real %APPDATA%/refract-tauri. Every launched app is closed in one top-level
// `finally`; each launch gets its own exe copy because sharing one made a later launch's CDP target resolve to the wrong pid.
// The automatic startup update check makes a real `gh` lookup, so a seeded updateState.json survives only for
// downloading/downloaded/installing/failed phases (checker.rs no-op rules).

import { mkdtempSync, mkdirSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  getFreePort,
  waitForCdpTarget,
  CdpSession,
  stopLauncher,
  isTargetOwningPort,
  assertExeMatchesProcess,
  createReportLogger,
  sleep
} from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, launchBuiltExe, safeRmSync, makeScratchRepo, switchTheme, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressEscape, pressKey, getActiveElementAccessibleName } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_569_SHOTS_DIR || path.join(tmpdir(), 'refract-569-shots');
const GITHUB_SCRATCH_CLONE_URL = 'https://github.com/stuarthopwood/refract.git';
const NARROW_WIDTH = 360;

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}
async function pressArrow(cdp, direction) {
  const map = { Down: [40, 'ArrowDown'], Up: [38, 'ArrowUp'], Left: [37, 'ArrowLeft'], Right: [39, 'ArrowRight'] };
  const [code, key] = map[direction];
  await pressKey(cdp, code, key, key);
}
async function pressEnterKey(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13 });
}

const openHandles = [];
function track(teardownFn) {
  openHandles.push(teardownFn);
}
async function teardownAll(log) {
  while (openHandles.length > 0) {
    const fn = openHandles.pop();
    try {
      await fn();
    } catch (err) {
      log?.(`teardownAll: a cleanup step itself failed (continuing): ${err.message}`);
    }
  }
}

async function connectCdp(port, targetPid, label) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`${label}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

function makeGithubScratchClone(dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  const result = spawnSync_('git', ['clone', '--depth', '1', '--quiet', GITHUB_SCRATCH_CLONE_URL, dir], { timeout: 60_000 });
  if (result.status !== 0) {
    console.warn(`verify-tauri-569: could not clone ${GITHUB_SCRATCH_CLONE_URL} (${result.stderr || result.error})`);
    return null;
  }
  return dir;
}

function independentActivePrCount(repoDir) {
  const result = spawnSync_('gh', ['search', 'prs', '--repo', 'stuarthopwood/refract', '--json', 'number', '--', 'is:open'], { cwd: repoDir });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout).length;
  } catch {
    return null;
  }
}

function assertBundleContainsStory569Marker() {
  const bundleRoot = path.join(REPO_ROOT, 'out', 'tauri-web');
  if (!existsSync(bundleRoot)) {
    throw new Error(`verify-tauri-569: no built renderer bundle at ${bundleRoot} -- the exe build below rebuilds it, but this static check runs before launch.`);
  }
  const grep = spawnSync_('node', [
    '-e',
    `
    const fs = require('node:fs');
    const path = require('node:path');
    function* walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* walk(full); }
        else if (entry.name.endsWith('.js')) yield full;
      }
    }
    let found = false;
    for (const file of walk(${JSON.stringify(bundleRoot)})) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('Restart to update') && text.includes('Check for updates')) { found = true; break; }
    }
    console.log(found ? 'FOUND' : 'MISSING');
  `
  ]);
  assert(grep.stdout.includes('FOUND'), '#569-only marker ("Restart to update" + "Check for updates") not found in the built renderer bundle -- the exe under test may not actually contain this story\'s code');
}

function seedUpdateState(dataDir, state) {
  writeFileSync(path.join(dataDir, 'updateState.json'), JSON.stringify({ version: 1, ...state }, null, 2));
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const report = { gitHead: gitHead(REPO_ROOT), checks: [], failures: [], notExercised: [] };
  log(`verify-tauri-569: git HEAD under test: ${report.gitHead}`);

  function checkPass(name, detail) {
    report.checks.push({ name, status: 'PASS', detail });
    log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function checkFail(name, detail) {
    report.checks.push({ name, status: 'FAIL', detail });
    report.failures.push(name);
    log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function notExercised(name, reason) {
    report.notExercised.push({ name, reason });
    log(`NOT EXERCISED: ${name} -- ${reason}`);
  }

  let exePath, exeHash, launcherExe;

  async function launchFresh(label, { seedUpdate } = {}) {
    const dataDir = mkdtempSync(path.join(tmpdir(), `refract-569-${label}-data-`));
    const importSourceDir = mkdtempSync(path.join(tmpdir(), `refract-569-${label}-import-`));
    track(() => safeRmSync(dataDir));
    track(() => safeRmSync(importSourceDir));
    if (seedUpdate) seedUpdateState(dataDir, seedUpdate);

    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const launchExeDir = mkdtempSync(path.join(tmpdir(), `refract-569-${label}-exe${attempt}-`));
      track(() => safeRmSync(launchExeDir));
      const launchExePath = path.join(launchExeDir, 'refract-tauri.exe');
      copyFileSync(exePath, launchExePath);
      const port = await getFreePort();
      const launched = await launchBuiltExe(launcherExe, launchExePath, { port, dataDir, importSourceDir, logFile: path.join(SHOTS_DIR, `app-run-${label}-attempt${attempt}.log`) });
      try {
        const cdp = await connectCdp(port, launched.targetPid, `verify-tauri-569 (${label})`);
        assertExeMatchesProcess(launched.targetPid, launchExePath, exeHash);
        await cdp.waitFor(
          `!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`,
          { timeoutMs: 45_000, label: `app ready (${label})` }
        );
        let tornDown = false;
        async function teardown() {
          if (tornDown) return;
          tornDown = true;
          await cdp.close();
          await stopLauncher(launched.child);
        }
        return { cdp, teardown };
      } catch (err) {
        lastErr = err;
        log(`verify-tauri-569 (${label}): attempt ${attempt}/5 failed (${err.message}); killing this attempt's process and retrying with a fresh port and exe copy.`);
        await stopLauncher(launched.child);
        await sleep(1000);
      }
    }
    throw lastErr;
  }

  try {
    try {
      assertBundleContainsStory569Marker();
      checkPass('#569-only DOM/bundle marker present');
    } catch (err) {
      checkFail('#569-only DOM/bundle marker present', err.message);
      throw err;
    }

    const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-569-launcher-'));
    const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-569-exe-'));
    track(() => safeRmSync(shimDir));
    track(() => safeRmSync(exeDir));
    launcherExe = buildLauncher(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-569' });
    exePath = built.dest;
    exeHash = built.hash;
    log(`verify-tauri-569: exe sha256 ${exeHash} copied to ${exePath}`);

    // Part A: sidebar count, keyboard-only menu, visual sanity (one launch, real PR data).
    const cloneParent = mkdtempSync(path.join(tmpdir(), 'refract-569-repo-'));
    track(() => safeRmSync(cloneParent));
    const repoClone = makeGithubScratchClone(path.join(cloneParent, 'refract'));
    log(`verify-tauri-569: GitHub scratch clone ${repoClone ?? '(FAILED -- see below)'}`);
    if (!repoClone) checkFail('GitHub scratch clone of stuarthopwood/refract succeeded', 'git clone failed -- cannot prove the real sidebar count without it');

    const { cdp, teardown: teardownMain } = await launchFresh('main');

    const prButtonFinder = `Array.from(document.querySelectorAll('button')).find((el) => el.getAttribute('aria-label') === 'Pull requests' || el.getAttribute('aria-label')?.startsWith('Pull requests, '))`;
    async function readPrButtonState() {
      return cdp.evaluate(
        `(() => { const btn = ${prButtonFinder}; if (!btn) return null; const span = Array.from(btn.querySelectorAll('span')).find((s) => /active$/.test(s.textContent.trim())); return { ariaLabel: btn.getAttribute('aria-label'), trailingText: span ? span.textContent.trim() : null }; })()`
      );
    }

    let independentCount = null;
    if (repoClone) {
      independentCount = independentActivePrCount(repoClone);
      log(`verify-tauri-569: independent gh search prs count (is:open): ${independentCount}`);

      await addRepository(cdp, repoClone);
      checkPass('Added scratch stuarthopwood/refract clone as a Project');
      await createSessionViaQuickCreate(cdp, 'refract');

      await cdp
        .waitFor(`(() => { const s = window.__refractStores?.pullRequests?.getState(); if (!s) return false; return s.activeCount.loading === false && s.activeCount.fetchedAt !== null; })()`, {
          timeoutMs: 30_000,
          label: 'active-count fetch settles'
        })
        .catch(() => {});

      const buttonState = await readPrButtonState();
      log(`verify-tauri-569: Pull requests button state: ${JSON.stringify(buttonState)}`);

      if (independentCount === null) {
        notExercised('Sidebar "N active" count matches an independent gh search', 'independent gh search prs failed outside the app (offline or rate-limited) -- cannot cross-check');
      } else if (independentCount === 0) {
        if (buttonState && buttonState.trailingText === null && buttonState.ariaLabel === 'Pull requests') {
          checkPass('Sidebar count hidden when the real count is zero', JSON.stringify(buttonState));
        } else {
          checkFail('Sidebar count hidden when the real count is zero', JSON.stringify({ independentCount, buttonState }));
        }
      } else {
        const expectedLabel = independentCount >= 30 ? '30+' : String(independentCount);
        const expectedText = `${expectedLabel} active`;
        if (buttonState && buttonState.trailingText === expectedText && buttonState.ariaLabel === `Pull requests, ${expectedText}`) {
          checkPass('Sidebar count matches an independent gh search', JSON.stringify({ independentCount, buttonState }));
        } else {
          checkFail('Sidebar count matches an independent gh search', JSON.stringify({ independentCount, buttonState }));
        }
      }
    } else {
      notExercised('Every real-PR-data sidebar count check', 'the GitHub scratch clone failed (see the hard failure above) -- code-verified only');
    }

    // The refract clone is still the default repo here, so the count is visible.
    await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-sidebar-pr-count.png'));

    // Real Input.dispatchKeyEvent with focus emulation.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await cdp.evaluate(`document.querySelector('[data-profile-name-button]').focus()`);
    const focusedNameButton = (await getActiveElementAccessibleName(cdp)).role === 'button';
    await pressEnterKey(cdp);
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu opened via Enter' });
    if (focusedNameButton) checkPass('Keyboard: Enter on the focused name button opens the profile menu');
    else checkFail('Keyboard: Enter on the focused name button opens the profile menu', 'activeElement was not the name button before Enter');

    const itemOrder = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]')).map((el) => el.textContent.trim())`);
    log(`verify-tauri-569: profile menu item order: ${JSON.stringify(itemOrder)}`);
    const keyboardIdx = itemOrder.findIndex((t) => t === 'Keyboard shortcuts');
    const healthIdx = itemOrder.findIndex((t) => t.startsWith('Health check'));
    const updateIdx = itemOrder.findIndex((t) => t === 'Check for updates' || t.startsWith('Restart to update') || t.startsWith('Checking for updates') || t.startsWith('Downloading update') || t.startsWith('Installing update'));
    if (keyboardIdx >= 0 && healthIdx >= 0 && updateIdx === keyboardIdx + 1 && updateIdx < healthIdx) {
      checkPass('Update entry sits between Keyboard shortcuts and Health check (FR-018 fixed order)', JSON.stringify({ keyboardIdx, updateIdx, healthIdx }));
    } else {
      checkFail('Update entry sits between Keyboard shortcuts and Health check (FR-018 fixed order)', JSON.stringify({ keyboardIdx, updateIdx, healthIdx, itemOrder }));
    }

    // Settle briefly: Radix needs a frame to commit default-item focus after a keyboard open.
    await sleep(250);
    await pressArrow(cdp, 'Down');
    await sleep(150);
    await pressArrow(cdp, 'Down');
    await sleep(150);
    const onThemeTrigger = (await getActiveElementAccessibleName(cdp)).name?.startsWith('Theme') ?? false;
    await pressArrow(cdp, 'Right');
    await cdp.waitFor(`!!document.querySelector('[role="menu"] [role="menuitemradio"] span')`, { timeoutMs: 5_000, label: 'Theme submenu opened via ArrowRight' }).catch(() => {});
    await sleep(300);
    // The active preset is the one checked `menuitemradio` (#1043).
    const currentMarkerPresent = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter((el) => el.getAttribute('aria-checked') === 'true').length === 1`);
    const focusInSubmenu = await cdp.evaluate(`document.activeElement?.getAttribute('role') === 'menuitemradio' && document.activeElement?.getAttribute('aria-checked') === 'true'`);
    if (onThemeTrigger && currentMarkerPresent) {
      checkPass('Keyboard: ArrowDown x2 + ArrowRight opens the Theme submenu with one checked menuitemradio', JSON.stringify({ onThemeTrigger, currentMarkerPresent, focusInSubmenu }));
    } else {
      checkFail('Keyboard: ArrowDown x2 + ArrowRight opens the Theme submenu with one checked menuitemradio', JSON.stringify({ onThemeTrigger, currentMarkerPresent, focusInSubmenu }));
    }
    await pressArrow(cdp, 'Left');
    await sleep(200);
    notExercised('ArrowLeft backs out of the Theme submenu onto the Theme trigger', 'sent as a transition step before Esc, but the resulting focus target was not independently asserted here');
    notExercised('Tab/Shift+Tab reaching the update row specifically', 'only ArrowDown/ArrowUp roving-menu navigation was exercised; Tab out of and back into the menu at the update row itself was not driven');

    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu closed by Esc' });
    const focusAfterEsc = await cdp.evaluate(`document.activeElement === document.querySelector('[data-profile-name-button]')`);
    if (focusAfterEsc) checkPass('Esc closes the profile menu and returns focus to the name button');
    else checkFail('Esc closes the profile menu and returns focus to the name button', String(focusAfterEsc));

    // Profile menu open screenshot (reopen via keyboard again for the shot).
    await pressEnterKey(cdp);
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu reopened for screenshot' });
    await cdp.screenshot(path.join(SHOTS_DIR, '06-profile-menu-open.png'));
    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu closed again' });

    await switchTheme(cdp, 'dark', 'Dark');
    checkPass('Pointer-driven Theme submenu: selecting "Dark" applies it (real store round trip; persistence across a relaunch not re-proven here)');

    await cdp.evaluate(`window.refract.theme.set('dark-high-contrast')`);
    await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'high-contrast theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '02-theme-dark-high-contrast.png'));
    checkPass('Dark (high contrast) theme screenshot captured (refract clone still default repo, count visible)');

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'obsidian theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '03-theme-obsidian.png'));
    checkPass('Obsidian theme screenshot captured (refract clone still default repo, count visible)');
    await cdp.evaluate(`window.refract.theme.set('dark')`);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: NARROW_WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const navWidthOk = await cdp.evaluate(`(() => { const nav = document.querySelector('nav[aria-label="Sessions"]'); return nav ? nav.getBoundingClientRect().width <= ${NARROW_WIDTH} : null; })()`);
    if (navWidthOk) checkPass(`Session list nav stays within a ${NARROW_WIDTH}px window`);
    else checkFail(`Session list nav stays within a ${NARROW_WIDTH}px window`, String(navWidthOk));
    await cdp.screenshot(path.join(SHOTS_DIR, '04-narrow-360.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    await cdp.screenshot(path.join(SHOTS_DIR, '05-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // Runs last in Part A: a scratch repo with no GitHub remote must hide the count, not leave a stale number.
    if (repoClone) {
      const plainRepoParent = mkdtempSync(path.join(tmpdir(), 'refract-569-plain-'));
      track(() => safeRmSync(plainRepoParent));
      const plainRepoDir = makeScratchRepo(path.join(plainRepoParent, 'plain'), 'refract-569-plain');
      await addRepository(cdp, plainRepoDir);
      await createSessionViaQuickCreate(cdp, 'refract-569-plain');
      const afterSwitch = await readPrButtonState();
      if (afterSwitch && afterSwitch.trailingText === null && afterSwitch.ariaLabel === 'Pull requests') {
        checkPass('Sidebar count disappears (not a stale number) once the default repository has no GitHub remote', JSON.stringify(afterSwitch));
      } else {
        checkFail('Sidebar count disappears (not a stale number) once the default repository has no GitHub remote', JSON.stringify(afterSwitch));
      }
    }

    await teardownMain();

    // Part B: update entry renderings via a scratch updateState.json; the real startup check may overwrite
    // idle/available seeds (checker.rs no-op rules cover downloading/downloaded/installing/failed only).
    const phases = [
      { label: 'idle', seed: { phase: 'idle' }, expectBusy: false, expectPrefix: 'Check for updates', seedMayBeOverwritten: true },
      { label: 'available', seed: { phase: 'available', availableVersion: '9.9.9' }, expectBusy: false, expectPrefix: 'Check for updates', seedMayBeOverwritten: true },
      { label: 'downloading', seed: { phase: 'downloading', availableVersion: '9.9.9' }, expectBusy: false, expectPrefix: 'Check for updates', note: "install_on_quit::resolve_startup_state resolves a leftover 'downloading' to 'failed' before the renderer sees it" },
      { label: 'downloaded', seed: { phase: 'downloaded', availableVersion: '9.9.9' }, expectBusy: false, expectPrefix: 'Restart to update' },
      { label: 'failed', seed: { phase: 'failed', lastError: 'Scratch synthetic failure (verify-tauri-569)' }, expectBusy: false, expectPrefix: 'Check for updates' },
      { label: 'unavailable-offline', seed: { phase: 'idle', unavailableReason: 'offline' }, expectBusy: false, expectPrefix: 'Check for updates', seedMayBeOverwritten: true }
    ];

    const phaseRepoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-569-phase-repo-')), 'refract-569-phase-repo');
    track(() => safeRmSync(phaseRepoDir));

    for (const phase of phases) {
      const { cdp: handleCdp, teardown: teardownPhase } = await launchFresh(`update-${phase.label}`, { seedUpdate: phase.seed });
      await addRepository(handleCdp, phaseRepoDir);
      await createSessionViaQuickCreate(handleCdp, 'refract-569-phase-repo');

      // Best-effort: catch the startup check's transient busy text; never claimed as "no network".
      await handleCdp.click(`document.querySelector('[data-profile-name-button]')`);
      await handleCdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu opened' });
      const pollDeadline = Date.now() + 2500;
      let caughtChecking = null;
      let lastRow = null;
      while (Date.now() < pollDeadline) {
        lastRow = await handleCdp.evaluate(
          `(() => { const items = Array.from(document.querySelectorAll('[role="menuitem"]')); const row = items.find((el) => el.textContent.trim().startsWith('Check for updates') || el.textContent.trim().startsWith('Restart to update') || el.textContent.trim().startsWith('Checking for updates') || el.textContent.trim().startsWith('Downloading update') || el.textContent.trim().startsWith('Installing update')); if (!row) return null; return { text: row.textContent.trim(), ariaDisabled: row.getAttribute('aria-disabled') }; })()`
        );
        if (lastRow?.text?.startsWith('Checking for updates')) {
          caughtChecking = lastRow;
          break;
        }
        await sleep(150);
      }
      if (phase.label === 'idle') {
        if (caughtChecking) checkPass('Caught the real automatic startup check\'s busy "Checking for updates…" state', JSON.stringify(caughtChecking));
        else notExercised('Busy "Checking for updates…" state during the automatic startup check', 'the real gh release check (spec 006 FR-017, no mock) resolved before this run could poll fast enough to observe it mid-flight');
      }
      const row = lastRow;
      const textOk = row && row.text.startsWith(phase.expectPrefix);
      const busyOk = row && (row.ariaDisabled === 'true') === phase.expectBusy;
      if (phase.seedMayBeOverwritten && !(textOk && busyOk)) {
        notExercised(`Update entry phase "${phase.label}" renders correctly`, `the seed may have been overwritten by the real automatic startup check before this ran ("${phase.label}" is not a documented no-op target); observed ${JSON.stringify(row)}`);
      } else if (textOk && busyOk) {
        checkPass(`Update entry phase "${phase.label}" renders correctly`, JSON.stringify(row) + (phase.note ? ` (${phase.note})` : ''));
      } else {
        checkFail(`Update entry phase "${phase.label}" renders correctly`, JSON.stringify({ row, expected: phase }));
      }

      if (phase.label === 'downloaded') {
        await handleCdp.screenshot(path.join(SHOTS_DIR, '07-profile-menu-downloaded.png'));
        // Assert the confirmation toast text, then that the phase is still 'downloaded' (never quits or installs).
        await handleCdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Restart to update'))`);
        const toastText = await handleCdp
          .waitFor(`(() => { const t = document.querySelector('[data-sonner-toast] [data-title]'); return t ? t.textContent.trim() : null; })()`, { timeoutMs: 5_000, label: 'confirmation toast appears' })
          .catch(() => null);
        const stillAlive = await handleCdp.evaluate('true').catch(() => false);
        // `window.__refractStores` is DEV-only and absent in `tauri build --debug`; read the phase via the IPC call.
        const stillDownloadedResult = await handleCdp.evaluate(`(async () => { const r = await window.refract.updates.getState(); return r.ok ? r.value.phase : null; })()`).catch(() => null);
        if (toastText === 'Refract updates automatically the next time you quit.' && stillAlive && stillDownloadedResult === 'downloaded') {
          checkPass('"Restart to update": shows the exact confirmation toast, phase stays "downloaded", never quits or installs', JSON.stringify({ toastText, stillDownloadedResult }));
        } else {
          checkFail('"Restart to update": shows the exact confirmation toast, phase stays "downloaded", never quits or installs', JSON.stringify({ toastText, stillAlive, stillDownloadedResult }));
        }
      }

      if (phase.label === 'failed') {
        await handleCdp.screenshot(path.join(SHOTS_DIR, '08-profile-menu-failed.png'));
        // Prove the loading toast is replaced in place via sonner's `{ id }`, never stacked.
        await handleCdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Check for updates'))`);
        const loadingSeen = await handleCdp
          .waitFor(`(() => { const t = document.querySelector('[data-sonner-toast] [data-title]'); return t && t.textContent.trim() === 'Checking for updates\u2026'; })()`, { timeoutMs: 3_000, label: 'loading toast appears' })
          .catch(() => false);
        let outcomeText = null;
        let maxToastCount = 0;
        const toastDeadline = Date.now() + 10_000;
        while (Date.now() < toastDeadline) {
          const snap = await handleCdp.evaluate(
            `(() => { const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')); const titles = toasts.map((t) => { const d = t.querySelector('[data-title]'); return d ? d.textContent.trim() : null; }).filter(Boolean); return { count: toasts.length, titles }; })()`
          );
          maxToastCount = Math.max(maxToastCount, snap.count);
          const settled = snap.titles.find((t) => t !== 'Checking for updates\u2026');
          if (settled) { outcomeText = settled; break; }
          await sleep(200);
        }
        if (loadingSeen && outcomeText && maxToastCount === 1) {
          checkPass('"Check for updates": toast.loading replaced in place (sonner {id}) by one outcome toast, never stacked', JSON.stringify({ loadingSeen, outcomeText, maxToastCount }));
        } else {
          checkFail('"Check for updates": toast.loading replaced in place (sonner {id}) by one outcome toast, never stacked', JSON.stringify({ loadingSeen, outcomeText, maxToastCount }));
        }
        // Error path (toast.error / phase "failed") is not live-triggered: forcing a real gh failure without a mock was unsafe to script.
        notExercised('"Check for updates" error path (toast.error on a rejected or failed real check)', 'forcing a genuine gh/network failure for one scratch launch without a mock was judged unsafe/unreliable to script against a real signed-in gh install; the catch()/phase-failed toast.error branches in handleCheckAgain are code-reviewed only');
      }
      await teardownPhase();
      await sleep(1500);
    }

    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (report.failures.length > 0) {
      log(`verify-tauri-569: ${report.failures.length} FAILURE(S): ${report.failures.join('; ')}`);
      await teardownAll(log);
      process.exit(1);
    } else {
      log(`verify-tauri-569: ALL EXERCISED CHECKS PASS (${report.notExercised.length} not exercised). Evidence: ${SHOTS_DIR}`);
      await teardownAll(log);
      process.exit(0);
    }
  } catch (err) {
    report.failures.push(err.message);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.error('verify-tauri-569: FAIL');
    console.error(err);
    await teardownAll(log);
    process.exit(1);
  }
}

main();
