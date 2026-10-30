// Helpers for scripts/verify-1048-holiday-touches.mjs (CPU budget, pointer/key taps, screenshot settling).
import { spawnSync } from 'node:child_process';
import { sleep } from './verify-tauri-cdp.mjs';

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

/** Total CPU-seconds of `rootPid` and all descendants: the WebView2 subprocesses do the painting, so the root PID alone undercounts (#1053). A process that exited mid-walk is skipped. */
export function processTreeCpuSeconds(rootPid) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
function Get-DescendantIds($parentId) {
  $ids = @($parentId)
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId"
  foreach ($c in $children) { $ids += Get-DescendantIds $c.ProcessId }
  return $ids
}
$ids = Get-DescendantIds ${rootPid}
$total = 0
foreach ($id in $ids) {
  $p = Get-Process -Id $id
  if ($p -and $p.CPU) { $total += $p.CPU }
}
Write-Output $total
`;
  const result = spawnSync_('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (result.status !== 0) return null;
  const value = Number.parseFloat((result.stdout ?? '').trim());
  return Number.isFinite(value) ? value : null;
}

/** Waits out tooltips and menus so a theme-switch screenshot never carries a leftover affordance (the profile menu's closing animation is still in flight after `switchTheme`). */
export async function settleForScreenshot(cdp) {
  await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.focus()`);
  await cdp.waitFor(`document.querySelectorAll('[role="tooltip"]').length === 0`, { timeoutMs: 5_000, label: 'No stray tooltip before screenshot' });
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'No stray open menu before screenshot' });
}

/** Trusted CDP press/release at an inert point in the transcript's empty area, resetting the loop's idle timer so a short `data-paused` wait can only be explained by the blur/hidden handler. */
export async function dispatchNeutralPointerdown(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 300, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 300, button: 'left', clickCount: 1 });
}

/** Trusted Shift keydown/keyup that keeps the loop's idle timer from firing during CPU sampling; Shift has no side effect on the composer. */
export async function dispatchShiftKeyTap(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
}

/** Fails the run when the projected CPU cost of the ambient loop exceeds 1.0s/60s, or paused cost exceeds budget.
 * Active cost = idle baseline + median per-flight excess x worst-case production flight rate, because debug-shortened
 * flight timing would otherwise inflate the figure. The idle baseline is a cited constant: the flight-interval env var
 * is fixed at launch, so it cannot be re-measured mid-run. Paused samples are 120s to dilute Windows' 1/64s CPU tick noise. */
export async function measureAmbientLoopCpuBudget(cdp, pid, report, assertTrue, assertEqual, { log, shortIdleMs, shortFlightIntervalMs, dispatchShiftKeyTap: tap }) {
  // Mirrors HolidayAmbientLoop.tsx production constants (90s min gap, 4s flight); a Node script cannot import the React module.
  const PRODUCTION_MIN_FLIGHT_GAP_S = 90;
  const PRODUCTION_FLIGHT_DURATION_S = 4;
  const WORST_CASE_FLIGHTS_PER_MINUTE = 60 / (PRODUCTION_MIN_FLIGHT_GAP_S + PRODUCTION_FLIGHT_DURATION_S);
  const IDLE_MANAGEMENT_BASELINE_S = 0.328;
  const IDLE_MANAGEMENT_BASELINE_SOURCE = 'docs/PLAN.md round-2 status update, head edcde895 ("Final budget: median active 0.328s/60s") -- not re-measured live this run: REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS is fixed in the OS process env block at launch, unreachable mid-run without a relaunch';
  const PER_FLIGHT_EXCESS_CEILING_S = 0.6;

  const refreshRateHz = await cdp.evaluate(`new Promise((resolve) => {
    let frames = 0;
    let start = null;
    function tick(t) {
      if (start === null) start = t;
      frames++;
      if (t - start >= 500) { resolve(Math.round((frames * 1000) / (t - start))); return; }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })`);

  async function readFlightCount() {
    return cdp.evaluate(`Number(document.querySelector('.holiday-ambient-loop')?.getAttribute('data-flight-count') ?? 0)`);
  }

  async function sampleMode(mode, durationMs, keepAwake) {
    await cdp.evaluate(`window.refract.settings.setHolidayTouches('${mode}')`);
    if (mode === 'full') {
      await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: `Ambient loop mounted for the ${mode} CPU budget sample` });
    } else {
      await cdp.waitFor(`!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: `Ambient loop unmounted for the ${mode} CPU budget sample` });
    }
    if (keepAwake) await tap(cdp);
    const pausedAtStart = mode === 'full' ? await cdp.evaluate(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`) : null;
    const flightCountAtStart = mode === 'full' ? await readFlightCount() : null;
    const before = processTreeCpuSeconds(pid);
    const ticks = Math.max(1, Math.floor(durationMs / 2000));
    for (let i = 0; i < ticks; i++) {
      if (keepAwake) await tap(cdp);
      await sleep(2000);
    }
    const after = processTreeCpuSeconds(pid);
    if (keepAwake) await tap(cdp);
    const pausedAtEnd = mode === 'full' ? await cdp.evaluate(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`) : null;
    const flightCountAtEnd = mode === 'full' ? await readFlightCount() : null;
    const flightCount = flightCountAtStart !== null && flightCountAtEnd !== null ? flightCountAtEnd - flightCountAtStart : null;
    return {
      cpuSeconds: before !== null && after !== null ? after - before : null,
      pausedAtStart,
      pausedAtEnd,
      flightCount
    };
  }

  async function samplePausedFull(durationMs) {
    await cdp.evaluate(`window.refract.settings.setHolidayTouches('full')`);
    await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop mounted before a paused-budget sample' });
    await sleep(shortIdleMs + 500);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, { timeoutMs: 5_000, label: 'Ambient loop paused before a paused-budget sample' });
    const before = processTreeCpuSeconds(pid);
    await sleep(durationMs);
    const after = processTreeCpuSeconds(pid);
    return before !== null && after !== null ? after - before : null;
  }

  const activeDeltas = [];
  const fullSamples = [];
  for (let round = 0; round < 3; round++) {
    const fullFirst = round % 2 === 0;
    let full;
    let artwork;
    if (fullFirst) {
      full = await sampleMode('full', 60_000, true);
      artwork = await sampleMode('artwork', 60_000, true);
    } else {
      artwork = await sampleMode('artwork', 60_000, true);
      full = await sampleMode('full', 60_000, true);
    }
    fullSamples.push(full);
    activeDeltas.push(full.cpuSeconds !== null && artwork.cpuSeconds !== null ? full.cpuSeconds - artwork.cpuSeconds : null);
  }
  const validActiveDeltas = activeDeltas.filter((d) => d !== null).sort((a, b) => a - b);
  const medianActiveDelta = validActiveDeltas.length > 0 ? validActiveDeltas[Math.floor(validActiveDeltas.length / 2)] : null;

  // Subtract the idle baseline, then divide by that round's own flight count: debug-shortened timing varies flights per window.
  const perFlightExcesses = activeDeltas.map((delta, i) => {
    const flights = fullSamples[i].flightCount;
    return delta !== null && flights !== null && flights > 0 ? (delta - IDLE_MANAGEMENT_BASELINE_S) / flights : null;
  });
  const validPerFlightExcesses = perFlightExcesses.filter((d) => d !== null).sort((a, b) => a - b);
  const medianPerFlightExcess = validPerFlightExcesses.length > 0 ? validPerFlightExcesses[Math.floor(validPerFlightExcesses.length / 2)] : null;
  const projectedProductionCostS = medianPerFlightExcess !== null ? IDLE_MANAGEMENT_BASELINE_S + medianPerFlightExcess * WORST_CASE_FLIGHTS_PER_MINUTE : null;

  // Paused samples are 120s, normalised per 60s below.
  const pausedDeltas = [];
  for (let round = 0; round < 3; round++) {
    const fullFirst = round % 2 === 0;
    let fullPausedCpu;
    let artworkCpu;
    if (fullFirst) {
      fullPausedCpu = await samplePausedFull(120_000);
      artworkCpu = (await sampleMode('artwork', 120_000, false)).cpuSeconds;
    } else {
      artworkCpu = (await sampleMode('artwork', 120_000, false)).cpuSeconds;
      fullPausedCpu = await samplePausedFull(120_000);
    }
    pausedDeltas.push(fullPausedCpu !== null && artworkCpu !== null ? (fullPausedCpu - artworkCpu) / 2 : null);
  }
  const validPausedDeltas = pausedDeltas.filter((d) => d !== null).sort((a, b) => a - b);
  const medianPausedDelta = validPausedDeltas.length > 0 ? validPausedDeltas[Math.floor(validPausedDeltas.length / 2)] : null;

  report.push({
    step: 'Ambient loop CPU budget (process tree, median of 3 alternating pairs, active and paused, honest per-flight projection)',
    ok: medianPerFlightExcess !== null && projectedProductionCostS !== null && medianPausedDelta !== null,
    refreshRateHz,
    activeDeltas,
    medianActiveDelta,
    fullSamples,
    perFlightExcesses,
    medianPerFlightExcess,
    idleManagementBaselineS: IDLE_MANAGEMENT_BASELINE_S,
    idleManagementBaselineSource: IDLE_MANAGEMENT_BASELINE_SOURCE,
    worstCaseFlightsPerMinute: WORST_CASE_FLIGHTS_PER_MINUTE,
    perFlightExcessCeilingS: PER_FLIGHT_EXCESS_CEILING_S,
    projectedProductionCostS,
    pausedDeltas,
    medianPausedDelta
  });
  console.log(`${log}: CPU budget -- refresh rate ${refreshRateHz}Hz, active deltas ${JSON.stringify(activeDeltas)}, median ${medianActiveDelta}s, full sample flight counts ${JSON.stringify(fullSamples.map((f) => f.flightCount))}, per-flight excesses ${JSON.stringify(perFlightExcesses)}, median ${medianPerFlightExcess}s, projected production-rate cost ${projectedProductionCostS}s, paused deltas (120s samples, normalised per 60s) ${JSON.stringify(pausedDeltas)}, median ${medianPausedDelta}s`);

  assertTrue(validActiveDeltas.length === 3, 'Ambient loop CPU budget: exactly 3 valid active samples', { activeDeltas });
  assertTrue(validPerFlightExcesses.length === 3, 'Ambient loop CPU budget: exactly 3 valid per-flight excess samples', { perFlightExcesses });
  assertTrue(validPausedDeltas.length === 3, 'Ambient loop CPU budget: exactly 3 valid paused samples', { pausedDeltas });
  fullSamples.forEach((full, i) => {
    assertTrue(full.pausedAtStart === false, `Full active sample ${i + 1}: not paused at start (keep-awake taps worked)`, full);
    assertTrue(full.pausedAtEnd === false, `Full active sample ${i + 1}: not paused at end (keep-awake taps worked)`, full);
    assertTrue(full.flightCount !== null && full.flightCount >= 1, `Full active sample ${i + 1}: at least one flight occurred (debug-shortened flight interval)`, full);
  });
  assertTrue(
    medianPerFlightExcess !== null && medianPerFlightExcess <= PER_FLIGHT_EXCESS_CEILING_S,
    `Ambient loop CPU budget: median per-flight CPU excess is at most ${PER_FLIGHT_EXCESS_CEILING_S}s (actual ${medianPerFlightExcess}s)`,
    { perFlightExcesses, medianPerFlightExcess, idleManagementBaselineS: IDLE_MANAGEMENT_BASELINE_S, idleManagementBaselineSource: IDLE_MANAGEMENT_BASELINE_SOURCE }
  );
  assertTrue(
    projectedProductionCostS !== null && projectedProductionCostS <= 1.0,
    `Ambient loop CPU budget: projected production-rate cost (idle-management baseline + median per-flight excess x worst-case flights/min) is at most 1.0s per 60s (actual ${projectedProductionCostS}s)`,
    { idleManagementBaselineS: IDLE_MANAGEMENT_BASELINE_S, idleManagementBaselineSource: IDLE_MANAGEMENT_BASELINE_SOURCE, medianPerFlightExcess, worstCaseFlightsPerMinute: WORST_CASE_FLIGHTS_PER_MINUTE, projectedProductionCostS }
  );
  assertTrue(
    medianPausedDelta !== null && medianPausedDelta <= 0.1,
    `Ambient loop CPU budget: median paused excess over Artwork-only is at most 0.1s per 60s (actual ${medianPausedDelta}s)`,
    { pausedDeltas, medianPausedDelta }
  );

  // getAnimations() is document-wide, so scope to the loop's subtree or unrelated animations (Radix transitions, spinners) give false failures.
  // One tap is not enough: the shortened idle pause (3s) cancels the flight timer (5s), so keep tapping until a flight runs.
  async function keepAwakeUntilFlightStarts(label) {
    const deadline = Date.now() + shortFlightIntervalMs + 15_000;
    while (Date.now() < deadline) {
      await tap(cdp);
      const running = await cdp.evaluate(`document.querySelector('.holiday-ambient-loop')?.getAnimations({ subtree: true }).length > 0`);
      if (running) return;
      await sleep(Math.min(1_500, shortIdleMs - 500));
    }
    throw new Error(`keepAwakeUntilFlightStarts: no flight started within ${shortFlightIntervalMs + 15_000}ms (${label})`);
  }
  await cdp.evaluate(`window.refract.settings.setHolidayTouches('full')`);
  await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop mounted before the mid-flight proof' });
  await keepAwakeUntilFlightStarts('mid-flight proof');
  const midFlight = await cdp.evaluate(`(() => {
    const animations = document.querySelector('.holiday-ambient-loop').getAnimations({ subtree: true });
    const bat = animations[0] && animations[0].effect ? animations[0].effect.target : null;
    return { animCount: animations.length, willChange: bat ? bat.style.willChange : null, targetClassName: bat ? bat.className : null };
  })()`);
  report.push({ step: 'Mid-flight: exactly one running Animation, flying bat has inline style.willChange', ok: midFlight.animCount === 1 && midFlight.willChange === 'transform', midFlight });
  assertEqual(midFlight.animCount, 1, 'Mid-flight: document.querySelector(\'.holiday-ambient-loop\').getAnimations({ subtree: true }).length is 1');
  assertEqual(midFlight.willChange, 'transform', "Mid-flight: the flying bat's own inline style.willChange is 'transform'");
  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAnimations({ subtree: true }).length === 0`, { timeoutMs: 10_000, label: 'Flight finishes naturally (getAnimations back to 0)' });
  const postFlight = await cdp.evaluate(`({
    animCount: document.querySelector('.holiday-ambient-loop').getAnimations({ subtree: true }).length,
    willChangeValues: Array.from(document.querySelectorAll('.holiday-ambient-loop-bat-wrap')).map((el) => el.style.willChange)
  })`);
  assertEqual(postFlight.animCount, 0, 'After the flight finishes: scoped getAnimations().length is 0');
  assertTrue(postFlight.willChangeValues.every((wc) => wc === ''), "After the flight finishes: every bat's own inline style.willChange is cleared ('')", postFlight);

  await keepAwakeUntilFlightStarts('blur-mid-flight proof');
  await cdp.evaluate(`window.dispatchEvent(new Event('blur'))`);
  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAnimations({ subtree: true }).length === 0`, { timeoutMs: 2_000, label: 'Blur mid-flight cancels the running Animation (getAnimations back to 0 quickly)' });
  // The animation leaves getAnimations() synchronously on cancel(), but the cancel event (which clears willChange) flushes later.
  await cdp.waitFor(`Array.from(document.querySelectorAll('.holiday-ambient-loop-bat-wrap')).every((el) => el.style.willChange === '')`, { timeoutMs: 2_000, label: "Every bat wrapper's willChange clears once the cancel event flushes" });
  const afterBlurMidFlight = await cdp.evaluate(`Array.from(document.querySelectorAll('.holiday-ambient-loop-bat-wrap')).map((el) => el.style.willChange)`);
  assertTrue(afterBlurMidFlight.every((wc) => wc === ''), "Blur mid-flight also clears every bat's own inline style.willChange", afterBlurMidFlight);
  await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`);
  await tap(cdp);
  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 5_000, label: 'Ambient loop resumes after the blur-mid-flight proof' });

  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 2_000, label: 'Loop confirmed not paused right before opening a real dialog' });
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(`!!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'A real dialog opens' });
  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, { timeoutMs: 2_000, label: 'Opening a real dialog pauses the ambient loop' });
  const dialogPauseAnimCount = await cdp.evaluate(`document.querySelector('.holiday-ambient-loop').getAnimations({ subtree: true }).length`);
  assertEqual(dialogPauseAnimCount, 0, 'No animation runs (scoped to the ambient loop) while a real dialog is open');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Dialog closed via Escape, no session created' });
}
