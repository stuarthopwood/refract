#!/usr/bin/env node
// Live CDP check for issue #569 (profile menu account header/icons/callouts, plus the sidebar
// Pull requests "N active" count). Reuses the shared scratch-isolation and CDP helpers the same
// way #568's own driver does (`refract-tauri-live-check-isolation` skill: own
// `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/`REFRACT_IMPORT_SOURCE_DIR`, never Stuart's real
// `%APPDATA%/refract-tauri`).
//
// Most of #569 (account header, per-item icons, Theme "Current" marker) was already built by an
// earlier story and is NOT re-proven here beyond a quick sanity screenshot -- see this story's
// decision record. What this script actually proves:
//   - A #569-only DOM/bundle marker (the literal "Restart to update"/"Check for updates" pair,
//     unique to the new `UpdateMenuItem`) is present before anything else is trusted.
//   - The sidebar "N active" count: added against a real read-only clone of
//     stuarthopwood/refract (never written to -- no comment/review/merge call is ever made),
//     cross-checked against an independent `gh search prs` run outside the app; then proved to
//     disappear (not flash a stale number) once the default repository changes to one with no
//     GitHub remote.
//   - Keyboard-only profile menu: fixed item order (the update entry sits between Keyboard
//     shortcuts and Health check, FR-018), arrow-key nav into/out of the Theme submenu, Esc
//     returns focus to the profile item's name button.
//   - The update entry's exact two renderings (FR-021), forced via a scratch `updateState.json`
//     seeded into the isolated data dir (no network): idle, available, downloading, downloaded,
//     failed, and GitHub-CLI-unavailable all collapse to "Check for updates" except downloaded
//     ("Restart to update vX.Y.Z", which never quits or installs on select).
//   - Dark, Obsidian/High contrast, 360px width, reduced motion.
//
// The exe is built ONCE (`buildAndCopyExeFresh`) and relaunched several times against different
// scratch data dirs for the update-entry phase sweep, rather than rebuilding per phase.

import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
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
import {
  gitHead,
  buildLauncher,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  makeScratchRepo,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { addRepository, pressTab, pressEscape } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR = process.env.REFRACT_569_SHOTS_DIR || 'C:/Users/shopwood/AppData/Local/Temp/refract-569-shots';
const GITHUB_SCRATCH_CLONE_URL = 'https://github.com/stuarthopwood/refract.git';
const NARROW_WIDTH = 360;

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function connectCdp(port, targetPid, label) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`${label}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

/** Clones `stuarthopwood/refract` itself, shallow and read-only (never written to -- this
 * script never calls `pullRequests.comment`/`submitReview`/`merge`). Returns `null` (never
 * throws) on failure so the caller fails the run loudly instead of faking a pass. */
function makeGithubScratchClone(dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  const result = spawnSync_('git', ['clone', '--depth', '1', '--quiet', GITHUB_SCRATCH_CLONE_URL, dir], { timeout: 60_000 });
  if (result.status !== 0) {
    console.warn(`verify-tauri-569: could not clone ${GITHUB_SCRATCH_CLONE_URL} (${result.stderr || result.error})`);
    return null;
  }
  return dir;
}

/** Ground truth for the sidebar count, run OUTSIDE the app: the exact query
 * `refreshActiveCount` (pull-requests-store.ts) issues for this repository. */
function independentActivePrCount(repoDir) {
  const result = spawnSync_('gh', ['search', 'prs', '--repo', 'stuarthopwood/refract', '--involves', '@me', '--json', 'number', '--', 'is:open'], {
    cwd: repoDir
  });
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

  let shimDir, exeDir, exePath, exeHash, launcherExe;

  // Launches the already-built/copied exe against a FRESH scratch data dir, waits for the app to
  // be ready for "Add repository", and returns a connected CdpSession plus teardown handles.
  async function launchFresh(label, { seedUpdate } = {}) {
    const dataDir = mkdtempSync(path.join(tmpdir(), `refract-569-${label}-data-`));
    const importSourceDir = mkdtempSync(path.join(tmpdir(), `refract-569-${label}-import-`));
    if (seedUpdate) seedUpdateState(dataDir, seedUpdate);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      logFile: path.join(SHOTS_DIR, `app-run-${label}.log`)
    });
    const cdp = await connectCdp(port, launched.targetPid, `verify-tauri-569 (${label})`);
    assertExeMatchesProcess(launched.targetPid, exePath, exeHash);
    await cdp.waitFor(
      `!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`,
      { timeoutMs: 45_000, label: `app ready (${label})` }
    );
    return { cdp, child: launched.child, dataDir, importSourceDir };
  }

  async function teardown(handle) {
    if (!handle) return;
    handle.cdp?.close();
    if (handle.child) await stopLauncher(handle.child);
    await safeRmSync(handle.dataDir);
    await safeRmSync(handle.importSourceDir);
  }

  try {
    try {
      assertBundleContainsStory569Marker();
      checkPass('#569-only DOM/bundle marker present');
    } catch (err) {
      checkFail('#569-only DOM/bundle marker present', err.message);
      throw err;
    }

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-569-launcher-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-569-exe-'));
    launcherExe = buildLauncher(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-569' });
    exePath = built.dest;
    exeHash = built.hash;
    log(`verify-tauri-569: exe sha256 ${exeHash} copied to ${exePath}`);

    // ---------------------------------------------------------------------------------------
    // Part A: the sidebar count, keyboard-only menu, and a visual sanity pass -- one launch,
    // with a real read-only clone of stuarthopwood/refract for real PR data.
    // ---------------------------------------------------------------------------------------
    const cloneParent = mkdtempSync(path.join(tmpdir(), 'refract-569-repo-'));
    const repoClone = makeGithubScratchClone(path.join(cloneParent, 'refract'));
    log(`verify-tauri-569: GitHub scratch clone ${repoClone ?? '(FAILED -- see below)'}`);
    if (!repoClone) checkFail('GitHub scratch clone of stuarthopwood/refract succeeded', 'git clone failed -- cannot prove the real sidebar count without it');

    const main_ = await launchFresh('main');
    const { cdp } = main_;

    if (repoClone) {
      const independentCount = independentActivePrCount(repoClone);
      log(`verify-tauri-569: independent gh search prs count (involves @me, is:open): ${independentCount}`);

      await addRepository(cdp, repoClone);
      checkPass('Added scratch stuarthopwood/refract clone as a Project');

      // The count fetches on mount via SessionList.tsx's own effect; wait for the store to
      // settle (loading -> a real value) before reading the DOM.
      await cdp
        .waitFor(
          `(() => { const s = window.__refractStores?.pullRequests?.getState(); if (!s) return false; const entry = Object.values(s.activeCountByRepository)[0]; return !!entry && entry.loading === false; })()`,
          { timeoutMs: 30_000, label: 'active-count fetch settles' }
        )
        .catch(() => {});

      const buttonState = await cdp.evaluate(
        `(() => { const btn = Array.from(document.querySelectorAll('button')).find((el) => el.getAttribute('aria-label') === 'Pull requests' || el.getAttribute('aria-label')?.startsWith('Pull requests, ')); if (!btn) return null; const span = Array.from(btn.querySelectorAll('span')).find((s) => /active$/.test(s.textContent.trim())); return { ariaLabel: btn.getAttribute('aria-label'), trailingText: span ? span.textContent.trim() : null }; })()`
      );
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

      await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-sidebar-pr-count.png'));

      // ---- Default-repository change: a second, plain scratch repo with NO GitHub remote,
      // opened via a new Session (making it the focused pane's repository) -- the sidebar
      // count must disappear (no-github-remote -> count: null -> hidden), not keep showing the
      // first repository's stale number. ----
      const plainRepoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-569-plain-')), 'refract-569-plain');
      await addRepository(cdp, plainRepoDir);
      await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]') && !document.querySelector('[aria-label="Message"]').disabled`, {
        timeoutMs: 60_000,
        label: 'new Session in the plain repo composer enabled (it becomes the focused pane)'
      });
      const afterSwitch = await cdp.evaluate(
        `(() => { const btn = Array.from(document.querySelectorAll('button')).find((el) => el.getAttribute('aria-label') === 'Pull requests' || el.getAttribute('aria-label')?.startsWith('Pull requests, ')); if (!btn) return null; const span = Array.from(btn.querySelectorAll('span')).find((s) => /active$/.test(s.textContent.trim())); return { ariaLabel: btn.getAttribute('aria-label'), trailingText: span ? span.textContent.trim() : null }; })()`
      );
      if (afterSwitch && afterSwitch.trailingText === null && afterSwitch.ariaLabel === 'Pull requests') {
        checkPass('Sidebar count disappears (not a stale number) once the default repository has no GitHub remote', JSON.stringify(afterSwitch));
      } else {
        checkFail('Sidebar count disappears (not a stale number) once the default repository has no GitHub remote', JSON.stringify(afterSwitch));
      }
    } else {
      notExercised('Every real-PR-data sidebar count check', 'the GitHub scratch clone failed (see the hard failure above) -- code-verified only');
    }

    // ---- Keyboard-only profile menu: fixed order, update entry position, arrow-key nav into
    // the Theme submenu, Esc returns focus to the name button. ----
    await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await cdp.click(`document.querySelector('[data-profile-name-button]')`);
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu opened' });
    const itemOrder = await cdp.evaluate(
      `Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]')).map((el) => el.textContent.trim())`
    );
    log(`verify-tauri-569: profile menu item order: ${JSON.stringify(itemOrder)}`);
    const keyboardIdx = itemOrder.findIndex((t) => t === 'Keyboard shortcuts');
    const healthIdx = itemOrder.findIndex((t) => t.startsWith('Health check'));
    const updateIdx = itemOrder.findIndex((t) => t === 'Check for updates' || t.startsWith('Restart to update'));
    if (keyboardIdx >= 0 && healthIdx >= 0 && updateIdx === keyboardIdx + 1 && updateIdx < healthIdx) {
      checkPass('Update entry sits between Keyboard shortcuts and Health check (FR-018 fixed order)', JSON.stringify({ keyboardIdx, updateIdx, healthIdx }));
    } else {
      checkFail('Update entry sits between Keyboard shortcuts and Health check (FR-018 fixed order)', JSON.stringify({ keyboardIdx, updateIdx, healthIdx, itemOrder }));
    }

    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu closed by Esc' });
    const focusAfterEsc = await cdp.evaluate(`document.activeElement === document.querySelector('[data-profile-name-button]')`);
    if (focusAfterEsc) checkPass('Esc closes the profile menu and returns focus to the name button');
    else checkFail('Esc closes the profile menu and returns focus to the name button', String(focusAfterEsc));

    // Theme submenu arrow-key nav (exercises the one keyboard path FR-024 names explicitly).
    await switchTheme(cdp, 'dark', 'Dark');
    checkPass('Keyboard-driven Theme submenu: selecting "Dark" applies and persists it (real store round trip)');

    await cdp.evaluate(`window.refract.theme.set('dark-high-contrast')`);
    await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'high-contrast theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '02-theme-dark-high-contrast.png'));
    checkPass('Dark (high contrast) theme screenshot captured');

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'obsidian theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '03-theme-obsidian.png'));
    checkPass('Obsidian theme screenshot captured');
    await cdp.evaluate(`window.refract.theme.set('dark')`);

    // ---- 360px width: the profile menu button row and its trailing count/icons stay inside
    // the actual left-nav width at the app's own narrow floor. ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: NARROW_WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const navWidthOk = await cdp.evaluate(`(() => { const nav = document.querySelector('nav[aria-label="Sessions"]'); return nav ? nav.getBoundingClientRect().width <= ${NARROW_WIDTH} : null; })()`);
    if (navWidthOk) checkPass(`Session list nav stays within a ${NARROW_WIDTH}px window`);
    else checkFail(`Session list nav stays within a ${NARROW_WIDTH}px window`, String(navWidthOk));
    await cdp.screenshot(path.join(SHOTS_DIR, '04-narrow-360.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // ---- Reduced motion ----
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    await cdp.screenshot(path.join(SHOTS_DIR, '05-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    await teardown(main_);
    await safeRmSync(cloneParent);

    // ---------------------------------------------------------------------------------------
    // Part B: the update entry's exact two renderings, forced via a scratch updateState.json
    // (no network) -- a fresh launch per phase, same copied exe.
    // ---------------------------------------------------------------------------------------
    async function profileMenuUpdateRow(cdpSession) {
      await cdpSession.click(`document.querySelector('[data-profile-name-button]')`);
      await cdpSession.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile menu opened' });
      return cdpSession.evaluate(
        `(() => { const items = Array.from(document.querySelectorAll('[role="menuitem"]')); const row = items.find((el) => el.textContent.trim().startsWith('Check for updates') || el.textContent.trim().startsWith('Restart to update')); if (!row) return null; return { text: row.textContent.trim(), ariaDisabled: row.getAttribute('aria-disabled') }; })()`
      );
    }

    const phases = [
      { label: 'idle', seed: { phase: 'idle' }, expectBusy: false, expectPrefix: 'Check for updates' },
      { label: 'available', seed: { phase: 'available', availableVersion: '9.9.9' }, expectBusy: false, expectPrefix: 'Check for updates' },
      { label: 'downloading', seed: { phase: 'downloading', availableVersion: '9.9.9' }, expectBusy: true, expectPrefix: 'Check for updates' },
      { label: 'downloaded', seed: { phase: 'downloaded', availableVersion: '9.9.9' }, expectBusy: false, expectPrefix: 'Restart to update' },
      { label: 'failed', seed: { phase: 'failed', lastError: 'Scratch synthetic failure (verify-tauri-569)' }, expectBusy: false, expectPrefix: 'Check for updates' },
      { label: 'unavailable-offline', seed: { phase: 'idle', unavailableReason: 'offline' }, expectBusy: false, expectPrefix: 'Check for updates' }
    ];

    for (const phase of phases) {
      let handle;
      try {
        handle = await launchFresh(`update-${phase.label}`, { seedUpdate: phase.seed });
        const row = await profileMenuUpdateRow(handle.cdp);
        const textOk = row && row.text.startsWith(phase.expectPrefix);
        const busyOk = row && (row.ariaDisabled === 'true') === phase.expectBusy;
        if (textOk && busyOk) {
          checkPass(`Update entry phase "${phase.label}" renders correctly`, JSON.stringify(row));
        } else {
          checkFail(`Update entry phase "${phase.label}" renders correctly`, JSON.stringify({ row, expected: phase }));
        }
        if (phase.label === 'downloaded') {
          await handle.cdp.click(
            `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Restart to update'))`
          );
          await sleep(500);
          // Never quits/installs on select -- the process must still be alive and the CDP
          // connection still responsive to a fresh evaluate.
          const stillAlive = await handle.cdp.evaluate('true').catch(() => false);
          if (stillAlive) checkPass('"Restart to update" never quits or installs on select (process still alive)');
          else checkFail('"Restart to update" never quits or installs on select (process still alive)', 'CDP connection died after selecting the item');
        }
      } finally {
        await teardown(handle);
      }
    }

    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (report.failures.length > 0) {
      log(`verify-tauri-569: ${report.failures.length} FAILURE(S): ${report.failures.join('; ')}`);
      process.exitCode = 1;
    } else {
      log(`verify-tauri-569: ALL EXERCISED CHECKS PASS (${report.notExercised.length} not exercised). Evidence: ${SHOTS_DIR}`);
    }
  } catch (err) {
    report.failures.push(err.message);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = 1;
    throw err;
  } finally {
    if (shimDir) await safeRmSync(shimDir);
    if (exeDir) await safeRmSync(exeDir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-569: FAIL');
  console.error(err);
  process.exitCode = 1;
});
