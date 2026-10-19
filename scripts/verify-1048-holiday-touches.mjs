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
// debug-only env vars (`src-tauri/src/ipc/debug.rs`), inert in a release build -- see this
// script's own README note below and the PR body for how that inertness was confirmed (reading
// the `#[cfg(debug_assertions)]` gate plus `Cargo.toml`'s lack of a `[profile.release]`
// `debug-assertions = true` override, not re-derived here).
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

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

/** Total CPU-seconds this process has consumed since it started, read via PowerShell
 * `Get-Process` (no perf-counter dependency, works for a single known PID). `null` if the
 * process cannot be read (exited, or `Get-Process` itself failed). */
function processCpuSeconds(pid) {
  const result = spawnSync_('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).CPU`]);
  if (result.status !== 0) return null;
  const value = Number.parseFloat((result.stdout ?? '').trim());
  return Number.isFinite(value) ? value : null;
}

/** Keeps `pid` busy-but-idle for `durationMs`: a trivial no-op mouse move every 2s (never a
 * click, never text input) so the ambient loop's own 60s/`REFRACT_HOLIDAY_IDLE_MS` auto-pause
 * does not fire mid-measurement -- without this, BOTH the Full and Off samples below would
 * mostly measure "app idle-paused", not "ambient loop actively running", making the comparison
 * meaningless. Returns the CPU-seconds consumed over the window. */
async function measureCpuSecondsOverWindow(cdp, pid, durationMs) {
  const before = processCpuSeconds(pid);
  const ticks = Math.max(1, Math.floor(durationMs / 2000));
  for (let i = 0; i < ticks; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50 + (i % 2) * 5, y: 50 });
    await sleep(2000);
  }
  const after = processCpuSeconds(pid);
  if (before === null || after === null) return null;
  return after - before;
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-1048-holiday-touches-shots', [
    ...THEMES.map((t) => `artwork-${t.id}.png`),
    'ambient-loop-full.png',
    'ambient-loop-artwork-only.png',
    'ambient-loop-off.png',
    'ambient-loop-reduced-motion.png',
    'ambient-loop-blurred.png',
    'spinner-working.png',
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

  /** The one DOM probe for "did holiday artwork render anywhere": the watermark/sidebar/spinner
   * all carry a lucide icon whose own class name is `lucide-<kebab-icon-name>`; Halloween's own
   * icon is `Ghost` -> `lucide-ghost`. Cheaper and more direct than asserting each placement's
   * own exact markup one at a time for the "present in all five placements" sweep. */
  const HALLOWEEN_ICON_CLASS = 'lucide-ghost';

  async function readArtworkPresence(cdp) {
    return cdp.evaluate(`(() => {
      const watermark = document.querySelector('.watermark-mark-holiday svg');
      const sidebarAccessory = document.querySelector('.drag-region svg.${HALLOWEEN_ICON_CLASS}');
      const emptyStateLine = Array.from(document.querySelectorAll('p')).find((el) => (el.textContent ?? '').includes('Boo! Nothing here but ghosts'));
      return {
        watermarkIsHoliday: !!(watermark && watermark.classList.contains('${HALLOWEEN_ICON_CLASS}')),
        sidebarAccessoryPresent: !!sidebarAccessory,
        emptyStateLinePresent: !!emptyStateLine,
        emptyStateLineAriaHidden: emptyStateLine ? emptyStateLine.getAttribute('aria-hidden') === 'true' : null
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

    // ---- Story-only marker before judging anything (UI gate checklist): the override actually
    // took effect, read back from the real IPC bridge, not re-derived client-side.
    // `cdp.evaluate` already awaits a returned Promise (`Runtime.evaluate`'s own
    // `awaitPromise: true`), so no IIFE/JSON.stringify wrapper is needed here. ----
    await cdp.waitFor(`!!(window.refract && window.refract.debug)`, { timeoutMs: 15_000, label: 'window.refract.debug available' });
    const overridesResult = await cdp.evaluate(`window.refract.debug.getOverrides()`);
    assertTrue(overridesResult.ok === true, 'debug.getOverrides() answers ok:true');
    assertEqual(overridesResult.value.date, HALLOWEEN_DATE_OVERRIDE, 'debug.getOverrides() reports the REFRACT_DATE_OVERRIDE env var verbatim');
    assertEqual(overridesResult.value.idleTimeoutMs, SHORT_IDLE_MS, 'debug.getOverrides() reports the REFRACT_HOLIDAY_IDLE_MS env var verbatim');

    // ---- Real UI flow: readiness, Add repository, New session ----
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
    // Story-only marker: a Session pane is genuinely mounted (not another lane's leftover exe).
    assertTrue(await cdp.evaluate(`!!document.querySelector('[data-slot="message-scroller-viewport"]') || !!document.querySelector('[aria-label="Message"]')`), 'Session pane marker present before judging anything');

    // ---- Five placements, five presets (Full is this exe's default setting) ----
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      const presence = await readArtworkPresence(cdp);
      assertTrue(presence.watermarkIsHoliday, `${theme.name}: chat watermark shows the Halloween (Ghost) glyph`, presence);
      assertTrue(presence.sidebarAccessoryPresent, `${theme.name}: sidebar logo accessory shows the Halloween glyph`, presence);
      await cdp.screenshot(path.join(SHOTS_DIR, `artwork-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');

    // ---- Empty-state line: a brand-new Session pane with no second pane open never reached
    // "No Session selected" in this flow (one Session is always focused) -- read via the Manage
    // sessions screen's own "No sessions yet" state is also unreachable (a Session now exists).
    // Both are instead asserted structurally: the SAME `holidayEntry` the watermark/sidebar read
    // already proved non-null above (the artwork checks above would not have passed otherwise),
    // and `ChatPane.tsx`/`ManageSessionsScreen.tsx` render the line from that same value with no
    // further gating -- recorded here, not independently screenshotted, since reaching either
    // empty state from this fixture would require closing the only open Session.
    notExercised.push('The two empty-state holiday lines ("No Session selected", "No sessions yet") render from the SAME holidayEntry value already proven present by the watermark/sidebar checks above; reaching either empty state live would require closing the only Session this fixture opens, out of scope for this run.');

    // ---- Start-message pool: this fixture sends its one turn before any assertion can observe
    // the starting-message text (it is shown only while `startProgress` is live, which this
    // fake-omp scenario does not hold open) -- recorded as not independently exercised, same
    // posture as the empty-state line above.
    notExercised.push('The start-message pool\'s holiday additions are not independently screenshotted: the fake-omp session scenario reaches a settled state before any assertion could read the transient starting-message text.');

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

    // ---- Window blur: a real DOM 'blur' event dispatch (the pause effect's own listener target
    // is `window`, so this exercises the real code path, not a state poke) pauses the loop;
    // 'focus' resumes it. ----
    await cdp.evaluate(`window.dispatchEvent(new Event('blur'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, { timeoutMs: 5_000, label: 'Ambient loop pauses on window blur' });
    await cdp.screenshot(path.join(SHOTS_DIR, 'ambient-loop-blurred.png'));
    await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 5_000, label: 'Ambient loop resumes on window focus (counts as input)' });

    // ---- Hidden document (Page Visibility API, overridden since `document.hidden` is a
    // read-only getter): pauses; becoming visible again and dispatching an input event
    // resumes. ----
    await cdp.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, { timeoutMs: 5_000, label: 'Ambient loop pauses when document.hidden becomes true' });
    await cdp.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 5_000, label: 'Ambient loop resumes once visible again plus an input event' });

    // ---- 60s idle (shortened to REFRACT_HOLIDAY_IDLE_MS via the debug override): no input at
    // all for just past the threshold pauses it; one input resumes it. ----
    await sleep(SHORT_IDLE_MS + 1_000);
    assertTrue((await readAmbientLoopState(cdp)).paused, `Ambient loop pauses after ${SHORT_IDLE_MS}ms idle (debug-shortened from the real 60s)`);
    await cdp.evaluate(`window.dispatchEvent(new Event('focus')); document.dispatchEvent(new PointerEvent('pointerdown'))`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 5_000, label: 'Ambient loop resumes on the next input after an idle pause' });

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
    if (spinnerAx.name) {
      notExercised.push(`The spinner element's own AX name ("${spinnerAx.name}") is empty by design (aria-hidden); the sr-only "Working" word lives on sessionDisplay.tsx's separate STATUS_LABEL text, asserted via its own sr-only span below.`);
    }
    const statusLabelPresent = await cdp.evaluate(`Array.from(document.querySelectorAll('span.sr-only')).some((el) => (el.textContent ?? '').trim() === 'Working')`);
    assertTrue(statusLabelPresent, `sr-only "Working" status label present while the spinner shows (sessionDisplay.tsx's own STATUS_LABEL, unaffected by the holiday glyph swap)`);
    await cdp.screenshot(path.join(SHOTS_DIR, 'spinner-working.png'));

    // ---- Spinner under reduced motion: static, upright (no rotation animation) ----
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

    // ---- Idle CPU, Full vs Off, over a real 60s window each (synthetic no-op mouse moves keep
    // both windows out of the idle auto-pause, so the comparison is "loop running" vs "no loop",
    // not "both idle-paused"). ----
    await cdp.evaluate(`window.refract.settings.setHolidayTouches('full')`);
    await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop active before the Full CPU sample' });
    const cpuFullSeconds = await measureCpuSecondsOverWindow(cdp, launched.targetPid, 60_000);
    await cdp.evaluate(`window.refract.settings.setHolidayTouches('off')`);
    await cdp.waitFor(`!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop gone before the Off CPU sample' });
    const cpuOffSeconds = await measureCpuSecondsOverWindow(cdp, launched.targetPid, 60_000);
    report.push({
      step: 'Idle CPU, Full vs Off, over 60s each (CPU-seconds consumed, lower is better)',
      ok: cpuFullSeconds !== null && cpuOffSeconds !== null,
      cpuFullSeconds,
      cpuOffSeconds,
      deltaSeconds: cpuFullSeconds !== null && cpuOffSeconds !== null ? cpuFullSeconds - cpuOffSeconds : null
    });
    console.log(`${LOG}: idle CPU over 60s -- Full: ${cpuFullSeconds}s, Off: ${cpuOffSeconds}s`);

    report.push({
      step: 'screenshots',
      ok: true,
      screenshots: citeScreenshots(SHOTS_DIR, [
        ...THEMES.map((t) => `artwork-${t.id}.png`),
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
    throw err;
  } finally {
    try {
      const failures = report.filter((r) => r.ok === false).map((r) => r.step);
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty, failures, notExercised, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
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
  }

  // ---- Baseline run: no date override at all (the real system date -- deliberately outside
  // every window, confirmed by OFF_SEASON_DATE_OVERRIDE's own value being used as a SEPARATE,
  // explicit "outside every window" run instead, since the real system date could itself
  // coincidentally fall inside a window on some future re-run of this script). Launched fresh,
  // not reusing the instance above, so this is a genuinely separate process to compare against. ----
  await runOffSeasonBaseline(head, dirty, report, notExercised);

  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

async function runOffSeasonBaseline(head, dirty, report, notExercised) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1048-holiday-touches-baseline');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-shim-'));
  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: `${LOG}-baseline` });
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
        REFRACT_DATE_OVERRIDE: OFF_SEASON_DATE_OVERRIDE
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: baseline CDP target on port ${port} is not owned by the process this run launched`);
    }
    const overridesResult = await cdp.evaluate(`window.refract.debug.getOverrides()`);
    const overridesMatch = overridesResult.ok === true && overridesResult.value.date === OFF_SEASON_DATE_OVERRIDE;
    report.push({ step: 'Baseline: debug.getOverrides() reports the off-season date override verbatim', ok: overridesMatch, actual: overridesResult });
    if (!overridesMatch) throw new Error(`FAIL: baseline debug.getOverrides() mismatch: ${JSON.stringify(overridesResult)}`);
    console.log(`${LOG}: PASS baseline: debug.getOverrides() reports the off-season date override verbatim`);

    // Past Readiness and a repository added (REAL UI flow, same as the main run), so the
    // sidebar and the "No Session selected" empty state are both genuinely mounted -- without
    // this, the absence check below would trivially pass on the Readiness screen alone, which
    // never mounts SessionList/ChatPane regardless of the date override working or not.
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'baseline: Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'baseline: Readiness green (fake omp)' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'baseline: Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'baseline: scratch repository added' }
    );

    const noHoliday = await cdp.evaluate(`(() => {
      const watermark = document.querySelector('.watermark-mark-holiday');
      const sidebarAccessory = document.querySelector('.drag-region svg.${HALLOWEEN_ICON_CLASS}');
      const ambientLoop = document.querySelector('.holiday-ambient-loop');
      return { watermarkPresent: !!watermark, sidebarAccessoryPresent: !!sidebarAccessory, ambientLoopPresent: !!ambientLoop };
    })()`);
    const ok = !noHoliday.watermarkPresent && !noHoliday.sidebarAccessoryPresent && !noHoliday.ambientLoopPresent;
    report.push({ step: 'Baseline (outside every window, sidebar + "No Session selected" both genuinely mounted): nothing holiday-related renders', ok, actual: noHoliday });
    if (!ok) throw new Error(`FAIL: baseline run outside every window still shows holiday content: ${JSON.stringify(noHoliday)}`);
    console.log(`${LOG}: PASS baseline (outside every window): nothing holiday-related renders anywhere`);
    await cdp.screenshot(path.join(SHOTS_DIR, 'baseline-no-override.png'));
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
