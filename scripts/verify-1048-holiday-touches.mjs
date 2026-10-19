#!/usr/bin/env node
// Live CDP check for issue #1048 (Holiday touches): the framework (pure calendar, the Settings
// control, the debug-only date/idle overrides) plus Halloween across all five placements (chat
// watermark, start messages, sidebar logo, both empty states, the agent-working spinner) and its
// ambient loop (drifting bats).
//
// Drives a scratch Tauri debug instance via a REAL `omp` stand-in (the recorded-frame fake omp,
// `session.jsonl` scenario -- a real approval + a streamed reply, used ONLY to get the Session
// into a genuine 'working' status long enough to screenshot the agent-working spinner's holiday
// glyph and read its AX tree; every other assertion here is a static DOM/computed-style read).
// `REFRACT_DATE_OVERRIDE=2026-10-27` (inside the Halloween window) and a short
// `REFRACT_HOLIDAY_IDLE_MS` (so the idle-pause path does not need a real 60s wait) are both
// debug-only env vars (`src-tauri/src/ipc/debug.rs`), inert in a release build -- see the PR body
// for how that inertness was confirmed.
//
// Gate round 1 (#1053) additions: elementFromPoint stacking-order proof (item 2), BOTH real
// empty states (`App.tsx`'s `[data-chat-empty-state]` and Manage sessions' "No sessions yet",
// item 3), a CPU measurement with real Shift taps that sums the exe's whole process tree (item
// 4), blur/hidden pause checks proving the pause is not just the idle timer firing (item 5), a
// Settings > Appearance screenshot, and screenshot hygiene before every shot.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 node
// scripts/verify-1048-holiday-touches.mjs (requires a prior `pnpm tauri build --debug
// --no-bundle`, the same convention every `verify-5xx-*.mjs`/`verify-9xx-*.mjs` script
// documents). NOT run until the build slot is granted -- syntax-checked only (`node --check`)
// before that.

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
// Outside every window (decision 4's six windows are all in Oct/Nov/Dec/Jan/Mar/May) -- the
// no-override baseline run uses this instead of the real system date, so the baseline is
// deterministic regardless of what day this script happens to run on.
const OFF_SEASON_DATE_OVERRIDE = '2026-07-15';
const SHORT_IDLE_MS = 3_000;
// Gate round 1 fix (High, item 5): well under SHORT_IDLE_MS, so a pause observed within this
// window can only be the blur/hidden handler, never a coincidental idle-timer firing.
const SHORT_PAUSE_PROOF_MS = 300;
// The one DOM probe for "did holiday artwork render anywhere": the watermark/sidebar/spinner
// all carry a lucide icon whose own class name is `lucide-<kebab-icon-name>`; Halloween's own
// icon is `Ghost` -> `lucide-ghost`. Module scope (used by both `main()` and
// `runOffSeasonBaseline()`).
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
        REFRACT_HOLIDAY_IDLE_MS: String(SHORT_IDLE_MS)
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

    // ---- Real UI flow: readiness, Add repository (no Session created yet) ----
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

    // ---- Gate round 1 fix (High, item 3a): the REAL empty chat pane (App.tsx's own
    // `[data-chat-empty-state]`, shown whenever no pane is open at all -- the common case, unlike
    // ChatPane.tsx's own rare `!session` branch) ----
    await cdp.waitFor(`!!document.querySelector('[data-chat-empty-state]')`, { timeoutMs: 15_000, label: 'Real empty chat pane (data-chat-empty-state) mounted' });
    const emptyPaneText = await cdp.evaluate(`document.querySelector('[data-chat-empty-state]').textContent`);
    assertTrue(emptyPaneText.includes(HALLOWEEN_EMPTY_LINE), 'Real empty chat pane shows the Halloween decorative line', { emptyPaneText });
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, 'empty-chat-pane.png'));

    // ---- Gate round 1 fix (High, item 3b): Manage sessions' own "No sessions yet" empty state ----
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

    // ---- New session ----
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

    // ---- Five placements, five presets ----
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

    // ---- Gate round 2 fix (Medium, item 6): the round 1 `elementFromPoint` proof can never
    // fail -- `pointer-events: none` already makes every browser hit-test skip the bat itself by
    // spec, so "never resolves to the bat" was tautological, not a real proof of paint order.
    // Asserting the COMPUTED `z-index` and the positioned ancestor's COMPUTED `isolation`
    // instead proves the actual mechanism this relies on: `-10` alone is a no-op without an
    // `isolate` ancestor creating the stacking context it paints BEHIND (without one, a
    // negative z-index can still paint above a sibling with no z-index of its own, depending on
    // DOM order). ----
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

    // ---- Ambient loop: Full (default) ----
    let loopState = await readAmbientLoopState(cdp);
    assertTrue(loopState.present, 'Ambient loop layer mounted with Full (default)', loopState);
    assertTrue(loopState.ariaHidden, 'Ambient loop layer is aria-hidden', loopState);
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-full.png'));

    // ---- Artwork only: static artwork stays, loop disappears ----
    await cdp.evaluate(`window.refract.settings.setHolidayTouches('artwork')`);
    await cdp.waitFor(`!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop unmounts under Artwork only' });
    const presenceArtworkOnly = await readArtworkPresence(cdp);
    assertTrue(presenceArtworkOnly.watermarkIsHoliday, 'Artwork only: watermark still shows holiday artwork', presenceArtworkOnly);
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-artwork-only.png'));

    // ---- Off: nothing holiday-related anywhere ----
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

    // ---- Back to Full for the pause-rule checks ----
    await cdp.evaluate(`window.refract.settings.setHolidayTouches('full')`);
    await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop remounts under Full' });

    // ---- Reduced motion: the loop layer itself is hidden outright (CSS, no JS needed) ----
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    const reducedMotionState = await readAmbientLoopState(cdp);
    assertTrue(reducedMotionState.displayNone, 'Ambient loop layer is display:none under emulated prefers-reduced-motion', reducedMotionState);
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.waitFor(`!getComputedStyle(document.querySelector('.holiday-ambient-loop')).display.includes('none')`, { timeoutMs: 5_000, label: 'Ambient loop layer visible again after reduced-motion emulation clears' });

    // ---- Gate round 1 fix (High, item 5): a REAL pointerdown resets the idle timer first, so
    // the SHORT (300ms, well under the 3000ms idle timeout) wait that follows can only be
    // explained by the blur/hidden handler itself -- never the idle timer coincidentally firing
    // inside the old 5s wait. Window blur (a real DOM 'blur' dispatch -- the pause effect's own
    // listener target is `window`, so this exercises the real code path; not a real OS minimise,
    // noted here explicitly). ----
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 2_000, label: 'Loop confirmed NOT paused right before the blur proof' });
    await cdp.evaluate(`window.dispatchEvent(new Event('blur'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, {
      timeoutMs: SHORT_PAUSE_PROOF_MS,
      label: `Ambient loop pauses on window blur within ${SHORT_PAUSE_PROOF_MS}ms (proves the blur handler, not a coincidental idle-timer fire)`
    });
    // Gate round 2 fix (Medium, item 9): this proof only ever lived in `cdp.waitFor`'s own
    // label, never in `report.json` -- added here so the evidence file carries it as a step.
    report.push({ step: `Ambient loop pauses on window blur within ${SHORT_PAUSE_PROOF_MS}ms (proves the blur handler, not a coincidental idle-timer fire)`, ok: true });
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-blurred.png'));
    await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: SHORT_PAUSE_PROOF_MS, label: 'Ambient loop resumes on window focus plus a real input' });

    // ---- Hidden document (Page Visibility API, overridden since `document.hidden` is a
    // read-only getter): same real-pointerdown-first proof as blur above. ----
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 2_000, label: 'Loop confirmed NOT paused right before the hidden proof' });
    await cdp.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, {
      timeoutMs: SHORT_PAUSE_PROOF_MS,
      label: `Ambient loop pauses when document.hidden becomes true within ${SHORT_PAUSE_PROOF_MS}ms (proves the visibility handler)`
    });
    // Gate round 2 fix (Medium, item 9): same as the blur proof above -- now a report.json step.
    report.push({ step: `Ambient loop pauses when document.hidden becomes true within ${SHORT_PAUSE_PROOF_MS}ms (proves the visibility handler)`, ok: true });
    await cdp.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange'))`);
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: SHORT_PAUSE_PROOF_MS, label: 'Ambient loop resumes once visible again plus a real input' });

    // ---- No input at all for just past SHORT_IDLE_MS pauses it; one real input resumes it. ----
    await sleep(SHORT_IDLE_MS + 1_000);
    assertTrue((await readAmbientLoopState(cdp)).paused, `Ambient loop pauses after ${SHORT_IDLE_MS}ms idle (debug-shortened from the real 60s)`);
    await dispatchNeutralPointerdown(cdp);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 5_000, label: 'Ambient loop resumes on the next real input after an idle pause' });

    // ---- Spinner: send the one real message this fixture's tape waits on (`session.jsonl`'s
    // own `__wait__: ["prompt"]`), approve its one tool call, then read the spinner DURING the
    // streaming delay that follows (the one real "working" window this scenario holds open). ----
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

    // ---- Settings > Appearance screenshot (the Holiday touches control itself) ----
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Settings screen opened' });
    await cdp.clickByText('Appearance', { tag: 'button' });
    await cdp.waitFor(`!!document.querySelector('#holiday-touches-select')`, { timeoutMs: 10_000, label: 'Appearance section shows the Holiday touches control' });
    await cdp.evaluate(`document.querySelector('#holiday-touches-select').scrollIntoView({ block: 'center' })`);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, 'settings-appearance.png'));
    // ---- Gate round 2 fix (Medium, item 9): exercises the REAL Settings control once, not only
    // the debug `window.refract.settings.setHolidayTouches` shortcut every other mode switch in
    // this script uses -- proves the actual Select wiring (SelectTrigger/SelectItem), not just
    // the underlying Zustand setter it calls. ----
    await cdp.click(`document.querySelector('#holiday-touches-select')`);
    await cdp.waitFor(`!!document.querySelector('[data-slot="select-item"]')`, { timeoutMs: 5_000, label: 'Holiday touches select options open' });
    await cdp.clickByText('Artwork only', { tag: '[data-slot="select-item"]' });
    await cdp.waitFor(`document.querySelector('#holiday-touches-select')?.textContent.includes('Artwork only')`, { timeoutMs: 5_000, label: 'Holiday touches select shows Artwork only after a real selection through the control itself' });
    await cdp.click(`document.querySelector('#holiday-touches-select')`);
    await cdp.waitFor(`!!document.querySelector('[data-slot="select-item"]')`, { timeoutMs: 5_000, label: 'Holiday touches select options open again' });
    await cdp.clickByText('Full', { tag: '[data-slot="select-item"]' });
    await cdp.waitFor(`document.querySelector('#holiday-touches-select')?.textContent.includes('Full')`, { timeoutMs: 5_000, label: 'Holiday touches select back to Full through the control itself' });
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 10_000, label: 'Back to chat from Settings' });

    // ---- Gate round 2 fix (High, items 1-2): the FAILING CPU budget check, replacing the
    // round 1 informational-only Full-vs-Off single sample -- median of 3 alternating
    // Full/Artwork-only 60s samples, plus a paused-state budget, both asserted against a hard
    // ceiling (see `measureAmbientLoopCpuBudget`'s own doc comment). ----
    await measureAmbientLoopCpuBudget(cdp, launched.targetPid, report, assertTrue, { log: LOG, shortIdleMs: SHORT_IDLE_MS, dispatchShiftKeyTap });

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

  // ---- Off-season override baseline, and the invalid-date-round-trip proof (item 11, decided
  // by Main: live, not a new Rust test) -- both SEPARATE fresh launches. Gate round 1 fix
  // (Medium, item 8): report.json is now written ONCE, after both complete, not before (the
  // baseline's own results used to be silently dropped since the file was already closed). ----
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
