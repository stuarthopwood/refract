// Helpers for scripts/verify-1048-holiday-touches.mjs, split out to keep that file under the
// 600-line soft cap (issue #806) once gate round 1's fixes (CPU-tree measurement, screenshot
// hygiene) were added.
import { spawnSync } from 'node:child_process';
import { sleep } from './verify-tauri-cdp.mjs';

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

/** Total CPU-seconds consumed by `rootPid` AND every descendant process -- gate round 1 fix
 * (High, #1053): the exe's own WebView2 subprocesses (renderer, GPU, utility, each its own PID
 * parented to the main exe) do the actual painting/compositing the ambient loop costs, so
 * summing only the root exe's PID badly undercounted the real cost. Walks `ParentProcessId` via
 * `Get-CimInstance Win32_Process` (read-only, no process control), then reads each PID's own
 * `.CPU` (total CPU-seconds consumed since that process started) via `Get-Process`. A process
 * that has already exited between the tree walk and the CPU read is silently skipped (`-Process
 * -ErrorAction SilentlyContinue` style `if ($p)` guard), never treated as a failure. */
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

/** Screenshot hygiene (gate round 1 fix, Medium, item 15): clicks the message box (closes any
 * open menu/dropdown, moves focus off whatever last had a hover-revealed tooltip), then waits
 * for every `[role="tooltip"]` to clear and every `[role="menu"]` to close -- a theme-switch
 * screenshot (`switchTheme` itself leaves the profile menu's own closing animation in flight for
 * a moment) must never carry a stray leftover affordance from the switch that produced it. */
export async function settleForScreenshot(cdp) {
  await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.focus()`);
  await cdp.waitFor(`document.querySelectorAll('[role="tooltip"]').length === 0`, { timeoutMs: 5_000, label: 'No stray tooltip before screenshot' });
  await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'No stray open menu before screenshot' });
}

/** A real, trusted CDP mouse press-then-release at a neutral point (never a click target that
 * does anything) -- counts as "input" to the ambient loop's own `pointerdown` listener,
 * resetting its idle timer, WITHOUT needing the untrusted `document.dispatchEvent` path. Used
 * right before a blur/hidden pause check (gate round 1 fix, High, item 5) so the loop is known
 * to be unpaused going in -- a SHORT subsequent wait (well under the idle timeout) for
 * `data-paused` can then only be explained by the blur/hidden handler itself, not a coincidental
 * idle-timer firing. Gate round 2 fix (Medium, item 9): moved off the sidebar's own
 * `SessionList.tsx` real estate (x:50 sat inside the session-list panel, a real interactive
 * surface with hover/selection state of its own) into the transcript's own empty area -- clearly
 * neutral chat-pane real estate, well clear of the header, composer and any bat silhouette's own
 * drift range. */
export async function dispatchNeutralPointerdown(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 300, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 300, button: 'left', clickCount: 1 });
}

/** A real, trusted CDP Shift keydown/keyup -- used to keep the ambient loop's own idle timer
 * from firing during the 60s CPU-measurement window (gate round 1 fix, High, item 4), since
 * Shift carries no side effect (never submits the composer, never types a character) and is
 * unambiguously a dispatched KEYBOARD event (the item's own "real Input.dispatchKeyEvent
 * (Shift)" wording), not a synthetic mouse move that the component's own `pointermove` listener
 * only started treating as activity in this same gate round. */
export async function dispatchShiftKeyTap(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
}

/** Gate round 2 fix (High, items 1 and 2), extended gate round 3 (High, item 1), made honest in
 * gate round 4 (Main's decision on #1048, 2026-10-20): a FAILING CPU budget check, not an
 * informational-only figure. Round 3 asserted the DEBUG-ACCELERATED median active delta (every
 * Full sample forced to several flights via `REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS`) directly
 * against the 1.0s/60s budget -- but that rate is several times the real production rate (the
 * real gap is randomised, not fixed), so it was asserting an artificially inflated number
 * against a budget meant for real usage. Round 4 instead measures the MEDIAN PER-FLIGHT CPU
 * excess (median of 3 rounds' own `(active delta - idle-management baseline) / that round's own
 * flight count`) and projects it to the real WORST-CASE production rate
 * (`worstCaseFlightsPerMinute = 60 / (minGap + duration)`, both read from
 * `HolidayAmbientLoop.tsx`'s own production constants: 90s min gap, 4s flight), asserting
 * `idleManagementBaselineS + medianPerFlightExcess * worstCaseFlightsPerMinute <= 1.0s`.
 * `idleManagementBaselineS` (0.328s) is gate round 2's own measured cost of Full mode's
 * idle-management machinery (listeners, idle timer, MutationObserver) with ZERO flights running
 * -- measured before this debug override existed, when the real randomised gap essentially
 * never landed a flight inside a single 60s sample (`docs/PLAN.md`'s own round-2 status update,
 * head `edcde895`: "Final budget: median active 0.328s/60s"). Gate round 4 fix (Main's decision
 * on #1048): investigated re-measuring this LIVE in the same run instead of a hard-coded
 * constant (a zero-flight Full sample, alternated against Artwork-only like the others) --
 * not possible without a relaunch: `debug.rs::resolve_overrides` reads
 * `REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS` live on every `debug.getOverrides()` call (never cached
 * Rust-side), but that env var itself lives in the OS process's own environment block, fixed at
 * launch by the parent process that spawned it -- there is no OS mechanism this script can use
 * to mutate an ALREADY-RUNNING process's own environment from outside. Kept as a constant,
 * `idleManagementBaselineSource` records its citation in `report.json` so a future reader (or a
 * future "re-verify this" pass) knows exactly where to find the run that measured it, rather
 * than trusting an uncited number.
 * A SEPARATE hard ceiling on the per-flight excess itself (<= 0.6s, regardless of production
 * rate) catches a regression in the flight's own cost directly, not just diluted by the
 * projection. Every input (both baselines, both
 * medians, the worst-case rate, the projected total) is recorded in `report.json`, not just the
 * pass/fail.
 *
 * Both the active and paused budgets are a median of 3 alternating Full/Artwork-only samples
 * (gate round 3 fix, item 7: a single pair was noisy against normal OS scheduling jitter) --
 * which mode is measured first alternates each round, so any monotonic drift across the whole
 * run affects both modes evenly rather than biasing one. Each active sample is kept genuinely
 * RUNNING via real dispatched Shift keydown/keyup every 2s (gate round 1 fix, High, item 4).
 * Gate round 4 fix: each PAUSED sample is now 120s (normalised back to a per-60s figure before
 * taking the median) -- a 60s paused sample's own delta sat close enough to the 0.1s/60s budget
 * that Windows' own 1/64s (0.015625s) `Get-Process.CPU` tick-quantization noise alone could tip
 * it either side of the threshold; doubling the window halves that noise's relative weight
 * without doubling the budget itself.
 *
 * Gate round 3 fix (High, item 1): the round 2 budget never actually caught a flight (the real
 * 90-180s gap almost never lands inside a single 60s sample), so this run launches with
 * `REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS` set short (passed in as `shortFlightIntervalMs`) -- every
 * Full sample's own flight count (`data-flight-count`, before/after the sample) is recorded and
 * asserted >= 1, and the start/end `data-paused` check is restored. Mid-flight
 * (`document.getAnimations().length === 1`, the flying bat WRAPPER's own inline
 * `style.willChange === 'transform'`) and post-flight (both `0` and `''`) are proven directly,
 * as is a blur THAT HAPPENS mid-flight (same `0`/`''` cleanup), and a REAL dialog opening (not a
 * simulated `role="dialog"` DOM poke) pausing the loop with no running animation. The display
 * refresh rate is recorded alongside (a 60/120/144Hz panel changes how many real frames the
 * flight's own 4s `ease-in-out` animation can produce -- useful context, not itself a pass/fail
 * input). This throws (fails the whole run) over budget or on any failed proof -- it is the
 * backstop against the CPU regression landing again unnoticed. */
export async function measureAmbientLoopCpuBudget(cdp, pid, report, assertTrue, assertEqual, { log, shortIdleMs, shortFlightIntervalMs, dispatchShiftKeyTap: tap }) {
  // Production constants mirrored from `HolidayAmbientLoop.tsx`'s own `scheduleNextFlight`/
  // `runFlight` (90_000 + Math.random() * 90_000 gap, 4_000ms duration) -- kept here, not
  // imported, since this is a Node script and that module is a React component bundled for the
  // renderer; a drift between the two would only ever make this projection MORE conservative in
  // one direction (if the real code's own numbers changed without this comment being updated,
  // whoever changes them again owns re-checking this file too).
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

  // ---- Active budget: 3 rounds, alternating which mode is sampled first. ----
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

  // ---- Per-flight excess: gate round 4 fix (Main's decision on #1048). Each round's own
  // active delta already mixes idle-management overhead with that round's own flight cost --
  // subtract the idle-management baseline FIRST, then divide by that SAME round's own flight
  // count, so a round that happened to produce more/fewer flights (debug-accelerated timing is
  // not perfectly deterministic across a 60s window) does not skew the per-flight figure. ----
  const perFlightExcesses = activeDeltas.map((delta, i) => {
    const flights = fullSamples[i].flightCount;
    return delta !== null && flights !== null && flights > 0 ? (delta - IDLE_MANAGEMENT_BASELINE_S) / flights : null;
  });
  const validPerFlightExcesses = perFlightExcesses.filter((d) => d !== null).sort((a, b) => a - b);
  const medianPerFlightExcess = validPerFlightExcesses.length > 0 ? validPerFlightExcesses[Math.floor(validPerFlightExcesses.length / 2)] : null;
  const projectedProductionCostS = medianPerFlightExcess !== null ? IDLE_MANAGEMENT_BASELINE_S + medianPerFlightExcess * WORST_CASE_FLIGHTS_PER_MINUTE : null;

  // ---- Paused budget: gate round 3 fix (item 7), 3 alternating pairs instead of 1; gate round 4
  // fix, each pair now 120s (normalised back to a per-60s figure below), see the docblock. ----
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

  // ---- Mid-flight and post-flight proofs (gate round 3, item 1). ----
  await cdp.evaluate(`window.refract.settings.setHolidayTouches('full')`);
  await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop mounted before the mid-flight proof' });
  await tap(cdp);
  await cdp.waitFor(`document.getAnimations().length > 0`, { timeoutMs: shortFlightIntervalMs + 15_000, label: 'A flight starts (debug-shortened interval)' });
  const midFlight = await cdp.evaluate(`(() => {
    const animations = document.getAnimations();
    const bat = animations[0] && animations[0].effect ? animations[0].effect.target : null;
    return { animCount: animations.length, willChange: bat ? bat.style.willChange : null };
  })()`);
  report.push({ step: 'Mid-flight: exactly one running Animation, flying bat has inline style.willChange', ok: midFlight.animCount === 1 && midFlight.willChange === 'transform', midFlight });
  assertEqual(midFlight.animCount, 1, 'Mid-flight: document.getAnimations().length is 1');
  assertEqual(midFlight.willChange, 'transform', "Mid-flight: the flying bat's own inline style.willChange is 'transform'");
  await cdp.waitFor(`document.getAnimations().length === 0`, { timeoutMs: 10_000, label: 'Flight finishes naturally (getAnimations back to 0)' });
  const postFlight = await cdp.evaluate(`({
    animCount: document.getAnimations().length,
    willChangeValues: Array.from(document.querySelectorAll('.holiday-ambient-loop-bat-wrap')).map((el) => el.style.willChange)
  })`);
  assertEqual(postFlight.animCount, 0, 'After the flight finishes: document.getAnimations().length is 0');
  assertTrue(postFlight.willChangeValues.every((wc) => wc === ''), "After the flight finishes: every bat's own inline style.willChange is cleared ('')", postFlight);

  // ---- Blur mid-flight leaves the same 0/'' state (gate round 3, item 1). ----
  await tap(cdp);
  await cdp.waitFor(`document.getAnimations().length > 0`, { timeoutMs: shortFlightIntervalMs + 15_000, label: 'A second flight starts, for the blur-mid-flight proof' });
  await cdp.evaluate(`window.dispatchEvent(new Event('blur'))`);
  await cdp.waitFor(`document.getAnimations().length === 0`, { timeoutMs: 2_000, label: 'Blur mid-flight cancels the running Animation (getAnimations back to 0 quickly)' });
  const afterBlurMidFlight = await cdp.evaluate(`Array.from(document.querySelectorAll('.holiday-ambient-loop-bat-wrap')).map((el) => el.style.willChange)`);
  assertTrue(afterBlurMidFlight.every((wc) => wc === ''), "Blur mid-flight also clears every bat's own inline style.willChange", afterBlurMidFlight);
  await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`);
  await tap(cdp);
  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 5_000, label: 'Ambient loop resumes after the blur-mid-flight proof' });

  // ---- Live dialog-pause step (gate round 3, item 1): a REAL dialog, not a simulated
  // role="dialog" DOM poke -- opening it must pause the loop with no running animation. ----
  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') !== 'true'`, { timeoutMs: 2_000, label: 'Loop confirmed not paused right before opening a real dialog' });
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(`!!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'A real dialog opens' });
  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, { timeoutMs: 2_000, label: 'Opening a real dialog pauses the ambient loop' });
  const dialogPauseAnimCount = await cdp.evaluate(`document.getAnimations().length`);
  assertEqual(dialogPauseAnimCount, 0, 'No animation runs while a real dialog is open');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Dialog closed via Escape, no session created' });
}
