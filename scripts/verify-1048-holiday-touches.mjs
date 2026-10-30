#!/usr/bin/env node
// Live CDP check for #1048 (Holiday touches): Halloween's five placements, the Settings control
// and the ambient bat loop, via a scratch debug build and the recorded-frame fake omp (used only to
// reach a 'working' status for the spinner). Needs a prior `pnpm tauri build --debug --no-bundle`
// and the shared CARGO_TARGET_DIR. REFRACT_DATE_OVERRIDE and REFRACT_HOLIDAY_IDLE_MS are debug-only.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles,
  getAccessibleNameAndRole
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { settleForScreenshot, dispatchNeutralPointerdown, dispatchShiftKeyTap, measureAmbientLoopCpuBudget } from './verify-1048-holiday-touches-helpers.mjs';
import { runOffSeasonBaseline, runInvalidDateOverrideCheck } from './verify-1048-holiday-touches-scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1048';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1048_SHOTS_DIR || path.join(tmpdir(), 'refract-1048-holiday-touches-shots');

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

// Inside the Halloween window (24-31 Oct) by a comfortable margin on both sides.
const HALLOWEEN_DATE_OVERRIDE = '2026-10-27';
// Outside every holiday window; keeps the baseline independent of the real system date.
const OFF_SEASON_DATE_OVERRIDE = '2026-07-15';
const SHORT_IDLE_MS = 3_000;
// Well under SHORT_IDLE_MS, so a pause within this window is the blur/hidden handler, not the idle timer.
const SHORT_PAUSE_PROOF_MS = 300;
// The real flight gap is 90-180s, so a short gap gives each 60s CPU sample several flights.
const SHORT_FLIGHT_INTERVAL_MS = 5_000;
// Holiday artwork carries a lucide icon class `lucide-<kebab-name>`; Halloween's is `Ghost`.
const HALLOWEEN_ICON_CLASS = 'lucide-ghost';
const HALLOWEEN_EMPTY_LINE = 'Boo! Nothing here but ghosts';

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-1048-holiday-touches-shots', [
    ...THEMES.map((t) => `artwork-${t.id}.png`),
    'empty-chat-pane.png',
    'manage-sessions-empty.png',
    'settings-appearance.png',
    'ambient-loop-full.png',
    'ambient-loop-artwork-only.png',
    'ambient-loop-off.png',
    'ambient-loop-reduced-motion.png',
    'ambient-loop-blurred.png',
    'spinner-working.png',
    'baseline-off-season.png',
    // Cleared through the guarded known-file clear: removes the stale pre-rename screenshot.
    'baseline-no-override.png',
    'report.json'
  ]);

  const report = [];
  const notExercised = [];

  function assertEqual(actual, expected, label) {
    const ok = actual === expected;
    report.push({ step: label, ok, actual, expected });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  function assertTrue(actual, label, extra) {
    const ok = actual === true;
    report.push({ step: label, ok, actual, ...(extra ? { extra } : {}) });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)})`);
    console.log(`${LOG}: PASS ${label}`);
  }

  async function readArtworkPresence(cdp) {
    return cdp.evaluate(`(() => {
      const watermark = document.querySelector('.watermark-mark-holiday svg');
      const sidebarAccessory = document.querySelector('.drag-region svg.${HALLOWEEN_ICON_CLASS}');
      return {
        watermarkIsHoliday: !!(watermark && watermark.classList.contains('${HALLOWEEN_ICON_CLASS}')),
        sidebarAccessoryPresent: !!sidebarAccessory
      };
    })()`);
  }

  async function readAmbientLoopState(cdp) {
    return cdp.evaluate(`(() => {
      const loop = document.querySelector('.holiday-ambient-loop');
      if (!loop) return { present: false };
      const style = getComputedStyle(loop);
      return {
        present: true,
        displayNone: style.display === 'none',
        paused: loop.getAttribute('data-paused') === 'true',
        ariaHidden: loop.getAttribute('aria-hidden') === 'true'
      };
    })()`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1048-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1048-holiday-touches');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-shim-'));

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_SCENARIO: 'session',
        REFRACT_DATE_OVERRIDE: HALLOWEEN_DATE_OVERRIDE,
        REFRACT_HOLIDAY_IDLE_MS: String(SHORT_IDLE_MS),
        REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS: String(SHORT_FLIGHT_INTERVAL_MS)
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    await cdp.waitFor(`!!(window.refract && window.refract.debug)`, { timeoutMs: 15_000, label: 'window.refract.debug available' });
    const overridesResult = await cdp.evaluate(`window.refract.debug.getOverrides()`);
    assertTrue(overridesResult.ok === true, 'debug.getOverrides() answers ok:true');
    assertEqual(overridesResult.value.date, HALLOWEEN_DATE_OVERRIDE, 'debug.getOverrides() reports the REFRACT_DATE_OVERRIDE env var verbatim');
    assertEqual(overridesResult.value.idleTimeoutMs, SHORT_IDLE_MS, 'debug.getOverrides() reports the REFRACT_HOLIDAY_IDLE_MS env var verbatim');
    assertEqual(overridesResult.value.flightIntervalMs, SHORT_FLIGHT_INTERVAL_MS, 'debug.getOverrides() reports the REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS env var verbatim');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );

    // The real empty chat pane (App.tsx `[data-chat-empty-state]`), not ChatPane's rare `!session` branch.
    await cdp.waitFor(`!!document.querySelector('[data-chat-empty-state]')`, { timeoutMs: 15_000, label: 'Real empty chat pane (data-chat-empty-state) mounted' });
    const emptyPaneText = await cdp.evaluate(`document.querySelector('[data-chat-empty-state]').textContent`);
    assertTrue(emptyPaneText.includes(HALLOWEEN_EMPTY_LINE), 'Real empty chat pane shows the Halloween decorative line', { emptyPaneText });
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, 'empty-chat-pane.png'));

    await cdp.click(`document.querySelector('[data-profile-name-button]')`);
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Manage sessions'))`, {
      timeoutMs: 10_000,
      label: 'Profile dropdown menu open (containing Manage sessions)'
    });
    await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Manage sessions')`);
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('h2,p,div')).find((el) => (el.textContent ?? '').trim() === 'No sessions yet')`, {
      timeoutMs: 15_000,
      label: 'Manage sessions screen: "No sessions yet" shown'
    });
    const manageSessionsText = await cdp.evaluate(`document.body.textContent`);
    assertTrue(manageSessionsText.includes(HALLOWEEN_EMPTY_LINE), 'Manage sessions "No sessions yet" shows the Halloween decorative line');
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, 'manage-sessions-empty.png'));
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await cdp.waitFor(`!!document.querySelector('[data-chat-empty-state]')`, { timeoutMs: 15_000, label: 'Back to chat: real empty pane mounted again' });

    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session composer enabled'
    });
    assertTrue(await cdp.evaluate(`!!document.querySelector('[aria-label="Message"]')`), 'Session pane marker present before judging anything');

    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await settleForScreenshot(cdp);
      const presence = await readArtworkPresence(cdp);
      assertTrue(presence.watermarkIsHoliday, `${theme.name}: chat watermark shows the Halloween (Ghost) glyph`, presence);
      assertTrue(presence.sidebarAccessoryPresent, `${theme.name}: sidebar logo accessory shows the Halloween glyph`, presence);
      await cdp.screenshot(path.join(SHOTS_DIR, `artwork-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');
    await settleForScreenshot(cdp);

    // `elementFromPoint` can't prove paint order (`pointer-events: none` skips the bat), so assert
    // computed `z-index` and the ancestor's `isolation`: a negative z-index needs an `isolate`
    // ancestor to paint behind a sibling.
    const batStackingCheck = await cdp.evaluate(`(() => {
      const loop = document.querySelector('.holiday-ambient-loop');
      const bats = Array.from(document.querySelectorAll('.holiday-ambient-loop-bat'));
      if (!loop) return null;
      const loopStyle = getComputedStyle(loop);
      const parentStyle = loop.parentElement ? getComputedStyle(loop.parentElement) : null;
      return {
        batCount: bats.length,
        loopZIndex: loopStyle.zIndex,
        parentIsolation: parentStyle ? parentStyle.isolation : null
      };
    })()`);
    assertTrue(batStackingCheck !== null && batStackingCheck.batCount === 3, 'Three bat silhouettes found for the stacking-order proof', batStackingCheck);
    assertEqual(batStackingCheck.loopZIndex, '-10', 'Ambient loop layer computed z-index is -10');
    assertEqual(batStackingCheck.parentIsolation, 'isolate', "Ambient loop layer's positioned ancestor computed isolation is isolate (the -10 z-index genuinely creates a BEHIND stacking context, not a no-op)");

    // With a full draft in the composer, no bat's resting or flight-end rect (offset
    // `translate(120px, 6px)`) may intersect the composer rect (FR-008).
    await cdp.typeIntoByLabel('Message', 'A full draft of several lines of text, long enough to grow the composer box taller than its single-line resting height, so the geometry check below exercises its real expanded size.\nA second line.\nA third line.');
    await settleForScreenshot(cdp);
    const composerFlightSafety = await cdp.evaluate(`(() => {
      const composer = document.querySelector('[aria-label="Message"]');
      if (!composer) return null;
      const composerRect = composer.getBoundingClientRect();
      const bats = Array.from(document.querySelectorAll('.holiday-ambient-loop-bat'));
      const intersects = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
      const results = bats.map((bat) => {
        const r = bat.getBoundingClientRect();
        const flown = { left: r.left + 120, right: r.right + 120, top: r.top + 6, bottom: r.bottom + 6 };
        return {
          restIntersectsComposer: intersects(r, composerRect),
          flightEndIntersectsComposer: intersects(flown, composerRect)
        };
      });
      return { composerRect, batCount: bats.length, results };
    })()`);
    assertTrue(composerFlightSafety !== null && composerFlightSafety.batCount === 3, 'Composer/bat geometry check found the composer and all three bats', composerFlightSafety);
    assertTrue(composerFlightSafety.results.every((r) => !r.restIntersectsComposer), 'No bat rests over the composer (full draft typed, composer at its real expanded height)', composerFlightSafety);
    assertTrue(composerFlightSafety.results.every((r) => !r.flightEndIntersectsComposer), 'No bat\'s flight-end position (its own rect offset by the flight\'s max translate(120px, 6px)) reaches the composer', composerFlightSafety);
    await cdp.evaluate(`document.querySelector('[aria-label="Message"]').select()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
    await cdp.waitFor(`document.querySelector('[aria-label="Message"]')?.value === ''`, { timeoutMs: 5_000, label: 'Composer draft cleared before continuing' });

    let loopState = await readAmbientLoopState(cdp);
    assertTrue(loopState.present, 'Ambient loop layer mounted with Full (default)', loopState);
    assertTrue(loopState.ariaHidden, 'Ambient loop layer is aria-hidden', loopState);
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-full.png'));

    await cdp.evaluate(`window.refract.settings.setHolidayTouches('artwork')`);
    await cdp.waitFor(`!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop unmounts under Artwork only' });
    const presenceArtworkOnly = await readArtworkPresence(cdp);
    assertTrue(presenceArtworkOnly.watermarkIsHoliday, 'Artwork only: watermark still shows holiday artwork', presenceArtworkOnly);
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-artwork-only.png'));

    await cdp.evaluate(`window.refract.settings.setHolidayTouches('off')`);
    await cdp.waitFor(`!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop stays unmounted under Off' });
    const presenceOff = await cdp.evaluate(`(() => {
      const watermark = document.querySelector('.watermark-mark-holiday');
      const sidebarAccessory = document.querySelector('.drag-region svg.${HALLOWEEN_ICON_CLASS}');
      return { watermarkPresent: !!watermark, sidebarAccessoryPresent: !!sidebarAccessory };
    })()`);
    assertTrue(!presenceOff.watermarkPresent, 'Off: watermark no longer shows holiday artwork', presenceOff);
    assertTrue(!presenceOff.sidebarAccessoryPresent, 'Off: sidebar accessory no longer present', presenceOff);
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-off.png'));

    await cdp.evaluate(`window.refract.settings.setHolidayTouches('full')`);
    await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop remounts under Full' });

    // Reduced motion hides the loop layer in CSS alone.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    const reducedMotionState = await readAmbientLoopState(cdp);
    assertTrue(reducedMotionState.displayNone, 'Ambient loop layer is display:none under emulated prefers-reduced-motion', reducedMotionState);
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.waitFor(`!getComputedStyle(document.querySelector('.holiday-ambient-loop')).display.includes('none')`, { timeoutMs: 5_000, label: 'Ambient loop layer visible again after reduced-motion emulation clears' });

    // A real pointerdown resets the idle timer first, so the short wait that follows can only be
    // the blur handler. A DOM 'blur' on `window` (the pause listener's target), not an OS minimise.
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 2_000, label: 'Loop confirmed NOT paused right before the blur proof' });
    await cdp.evaluate(`window.dispatchEvent(new Event('blur'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, {
      timeoutMs: SHORT_PAUSE_PROOF_MS,
      label: `Ambient loop pauses on window blur within ${SHORT_PAUSE_PROOF_MS}ms (proves the blur handler, not a coincidental idle-timer fire)`
    });
    report.push({ step: `Ambient loop pauses on window blur within ${SHORT_PAUSE_PROOF_MS}ms (proves the blur handler, not a coincidental idle-timer fire)`, ok: true });
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-blurred.png'));
    await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: SHORT_PAUSE_PROOF_MS, label: 'Ambient loop resumes on window focus plus a real input' });

    // `document.hidden` is a read-only getter, so it is overridden; same pointerdown-first proof as blur.
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 2_000, label: 'Loop confirmed NOT paused right before the hidden proof' });
    await cdp.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, {
      timeoutMs: SHORT_PAUSE_PROOF_MS,
      label: `Ambient loop pauses when document.hidden becomes true within ${SHORT_PAUSE_PROOF_MS}ms (proves the visibility handler)`
    });
    report.push({ step: `Ambient loop pauses when document.hidden becomes true within ${SHORT_PAUSE_PROOF_MS}ms (proves the visibility handler)`, ok: true });
    await cdp.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange'))`);
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: SHORT_PAUSE_PROOF_MS, label: 'Ambient loop resumes once visible again plus a real input' });

    await sleep(SHORT_IDLE_MS + 1_000);
    assertTrue((await readAmbientLoopState(cdp)).paused, `Ambient loop pauses after ${SHORT_IDLE_MS}ms idle (debug-shortened from the real 60s)`);
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 5_000, label: 'Ambient loop resumes on the next real input after an idle pause' });

    // Send the message `session.jsonl` waits on, approve its tool call, then read the spinner
    // during the streaming delay (the only 'working' window the scenario holds open).
    await cdp.typeIntoByLabel('Message', 'trigger the scripted turn');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'Approval card rendered' });
    await cdp.clickByText('Approve');
    const spinnerSelector = `Array.from(document.querySelectorAll('.agent-spinner-holiday'))[0]`;
    await cdp.waitFor(`!!(${spinnerSelector})`, { timeoutMs: 10_000, label: 'Holiday spinner glyph (.agent-spinner-holiday) rendered while working' });
    const spinnerStyle = await cdp.evaluate(`(() => {
      const el = ${spinnerSelector};
      const style = getComputedStyle(el);
      return { color: style.color, className: el.getAttribute('class'), width: el.getAttribute('width'), height: el.getAttribute('height') };
    })()`);
    assertTrue(spinnerStyle.className.includes('lucide-ghost'), 'Spinner glyph is the Halloween Ghost icon', spinnerStyle);
    const spinnerAx = await getAccessibleNameAndRole(cdp, spinnerSelector);
    report.push({ step: 'Spinner accessible name/role via AX tree', ok: true, spinnerAx });
    const statusLabelPresent = await cdp.evaluate(`Array.from(document.querySelectorAll('span.sr-only')).some((el) => (el.textContent ?? '').trim() === 'Working')`);
    assertTrue(statusLabelPresent, `sr-only "Working" status label present while the spinner shows (sessionDisplay.tsx's own STATUS_LABEL, unaffected by the holiday glyph swap)`);
    await cdp.screenshot(path.join(SHOTS_DIR, 'spinner-working.png'));

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
    const spinnerReducedMotion = await cdp.evaluate(`(() => {
      const el = ${spinnerSelector};
      if (!el) return null;
      return getComputedStyle(el).animationName;
    })()`);
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    if (spinnerReducedMotion !== null) {
      assertEqual(spinnerReducedMotion, 'none', 'Spinner glyph animation-name is "none" under emulated prefers-reduced-motion (static, upright glyph)');
    } else {
      notExercised.push('The spinner had already unmounted (the fixture\'s own turn settled) by the time the reduced-motion check ran; the CSS rule itself (`@media (prefers-reduced-motion: reduce) { .agent-spinner-holiday { animation: none } }`) is unconditional and theme-independent, so this is a timing gap in the script, not in the fix.');
    }

    await cdp.waitFor(`document.querySelectorAll('[aria-label="Message"]').length > 0 && !document.querySelector('[aria-label="Message"]').disabled`, { timeoutMs: 30_000, label: 'Fixture turn settles' });

    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Settings screen opened' });
    await cdp.clickByText('Appearance', { tag: 'button' });
    await cdp.waitFor(`!!document.querySelector('#holiday-touches-select')`, { timeoutMs: 10_000, label: 'Appearance section shows the Holiday touches control' });
    await cdp.evaluate(`document.querySelector('#holiday-touches-select').scrollIntoView({ block: 'center' })`);
    // Use the real Settings control before the screenshot, so it shows the post-use state (closed menu).
    await cdp.click(`document.querySelector('#holiday-touches-select')`);
    await cdp.waitFor(`!!document.querySelector('[data-slot="select-item"]')`, { timeoutMs: 5_000, label: 'Holiday touches select options open' });
    await cdp.clickByText('Artwork only', { tag: '[data-slot="select-item"]' });
    await cdp.waitFor(`document.querySelector('#holiday-touches-select')?.textContent.includes('Artwork only')`, { timeoutMs: 5_000, label: 'Holiday touches select shows Artwork only after a real selection through the control itself' });
    await cdp.click(`document.querySelector('#holiday-touches-select')`);
    await cdp.waitFor(`!!document.querySelector('[data-slot="select-item"]')`, { timeoutMs: 5_000, label: 'Holiday touches select options open again' });
    await cdp.clickByText('Full', { tag: '[data-slot="select-item"]' });
    await cdp.waitFor(`document.querySelector('#holiday-touches-select')?.textContent.includes('Full')`, { timeoutMs: 5_000, label: 'Holiday touches select back to Full through the control itself' });
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, 'settings-appearance.png'));
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 10_000, label: 'Back to chat from Settings' });

    // Failing CPU budget: median of 3 alternating Full/Artwork-only 60s samples plus a paused budget
    // (see `measureAmbientLoopCpuBudget`).
    await measureAmbientLoopCpuBudget(cdp, launched.targetPid, report, assertTrue, assertEqual, { log: LOG, shortIdleMs: SHORT_IDLE_MS, shortFlightIntervalMs: SHORT_FLIGHT_INTERVAL_MS, dispatchShiftKeyTap });

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [
        ...THEMES.map((t) => `artwork-${t.id}.png`),
        'empty-chat-pane.png',
        'manage-sessions-empty.png',
        'settings-appearance.png',
        'ambient-loop-full.png',
        'ambient-loop-artwork-only.png',
        'ambient-loop-off.png',
        'ambient-loop-reduced-motion.png',
        'ambient-loop-blurred.png',
        'spinner-working.png'
      ])
    });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
    writeReport(head, dirty, report, notExercised);
    throw err;
  }
  if (cdp) cdp.close();
  if (child) await stopLauncher(child).catch(() => {});
  await safeRmSync(dataDir, LOG);
  await safeRmSync(importSourceDir, LOG);
  await safeRmSync(repoDirBase, LOG);
  await safeRmSync(worktreesRootForCleanup, LOG);
  await safeRmSync(exeDir, LOG);
  await safeRmSync(launcherDir, LOG);
  await safeRmSync(shimDir, LOG);

  // Off-season baseline and invalid-date round trip run in separate fresh launches; report.json
  // is written once, after both finish.
  await runOffSeasonBaseline({ repoRoot: REPO_ROOT, buildOutputDir: BUILD_OUTPUT_DIR, shotsDir: SHOTS_DIR, dateOverride: OFF_SEASON_DATE_OVERRIDE, hallowenIconClass: HALLOWEEN_ICON_CLASS, emptyLine: HALLOWEEN_EMPTY_LINE, report });
  await runInvalidDateOverrideCheck({ repoRoot: REPO_ROOT, buildOutputDir: BUILD_OUTPUT_DIR, report });

  writeReport(head, dirty, report, notExercised);
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

function writeReport(head, dirty, report, notExercised) {
  try {
    const failures = report.filter((r) => r.ok === false).map((r) => r.step);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty, failures, notExercised, results: report }, null, 2));
  } catch (writeErr) {
    console.error(`${LOG}: failed to write report.json: ${writeErr}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
