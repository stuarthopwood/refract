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

/** Gate round 2 fix (High, items 1 and 2): a FAILING CPU budget check, not an informational-only
 * figure -- the ambient loop must cost at most 1.0s of process-tree CPU per 60s ABOVE
 * Artwork-only (not Off: Artwork-only still shows the static watermark artwork, so comparing
 * against it isolates the cost of the ANIMATED loop itself, never the icon swap), plus at most
 * 0.1s/min above Artwork-only while genuinely paused (idle). Median of 3 alternating
 * Full/Artwork-only 60s samples (which mode is measured first alternates each round, so any
 * monotonic drift across the whole ~6-minute window affects both modes evenly rather than
 * biasing one), each kept genuinely RUNNING via real dispatched Shift keydown/keyup every 2s
 * (gate round 1 fix, High, item 4: a plain synthetic mouse move used to leave the loop
 * idle-paused for almost the whole window, measuring "app idle" twice over, not "loop running"
 * vs "no loop"). The display refresh rate is recorded alongside (a 60/120/144Hz panel changes
 * how many real frames a `steps(26)`-timed animation can even produce -- useful context for any
 * future tuning, not itself a pass/fail input). This throws (fails the whole run) over budget --
 * it is the backstop against the CPU regression landing again unnoticed. */
export async function measureAmbientLoopCpuBudget(cdp, pid, report, assertTrue, { log, shortIdleMs, dispatchShiftKeyTap: tap }) {
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

  async function sampleMode(mode, durationMs, keepAwake) {
    await cdp.evaluate(`window.refract.settings.setHolidayTouches('${mode}')`);
    if (mode === 'full') {
      await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: `Ambient loop mounted for the ${mode} CPU budget sample` });
    } else {
      await cdp.waitFor(`!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: `Ambient loop unmounted for the ${mode} CPU budget sample` });
    }
    if (keepAwake) await tap(cdp);
    const before = processTreeCpuSeconds(pid);
    const ticks = Math.max(1, Math.floor(durationMs / 2000));
    for (let i = 0; i < ticks; i++) {
      if (keepAwake) await tap(cdp);
      await sleep(2000);
    }
    const after = processTreeCpuSeconds(pid);
    return before !== null && after !== null ? after - before : null;
  }

  const activeDeltas = [];
  for (let round = 0; round < 3; round++) {
    const fullFirst = round % 2 === 0;
    let fullCpu;
    let artworkCpu;
    if (fullFirst) {
      fullCpu = await sampleMode('full', 60_000, true);
      artworkCpu = await sampleMode('artwork', 60_000, true);
    } else {
      artworkCpu = await sampleMode('artwork', 60_000, true);
      fullCpu = await sampleMode('full', 60_000, true);
    }
    activeDeltas.push(fullCpu !== null && artworkCpu !== null ? fullCpu - artworkCpu : null);
  }
  const validActiveDeltas = activeDeltas.filter((d) => d !== null).sort((a, b) => a - b);
  const medianActiveDelta = validActiveDeltas.length > 0 ? validActiveDeltas[Math.floor(validActiveDeltas.length / 2)] : null;

  // ---- Paused budget: Full, left genuinely idle (no taps) past the debug-shortened idle
  // timeout so `data-paused` is true throughout, against Artwork-only over the same window. ----
  await cdp.evaluate(`window.refract.settings.setHolidayTouches('full')`);
  await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Ambient loop mounted before the paused-budget sample' });
  await sleep(shortIdleMs + 500);
  await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, { timeoutMs: 5_000, label: 'Ambient loop paused before the paused-budget sample' });
  const fullPausedBefore = processTreeCpuSeconds(pid);
  await sleep(60_000);
  const fullPausedAfter = processTreeCpuSeconds(pid);
  const fullPausedCpu = fullPausedBefore !== null && fullPausedAfter !== null ? fullPausedAfter - fullPausedBefore : null;
  const artworkPausedCpu = await sampleMode('artwork', 60_000, false);
  const pausedDelta = fullPausedCpu !== null && artworkPausedCpu !== null ? fullPausedCpu - artworkPausedCpu : null;

  report.push({
    step: 'Ambient loop CPU budget (process tree, median of 3 alternating Full/Artwork-only 60s samples)',
    ok: medianActiveDelta !== null && pausedDelta !== null,
    refreshRateHz,
    activeDeltas,
    medianActiveDelta,
    fullPausedCpu,
    artworkPausedCpu,
    pausedDelta
  });
  console.log(`${log}: CPU budget -- refresh rate ${refreshRateHz}Hz, active deltas ${JSON.stringify(activeDeltas)}, median ${medianActiveDelta}s, paused delta ${pausedDelta}s`);
  assertTrue(
    medianActiveDelta !== null && medianActiveDelta <= 1.0,
    `Ambient loop CPU budget: median active excess over Artwork-only is at most 1.0s per 60s (actual ${medianActiveDelta}s)`,
    { activeDeltas, medianActiveDelta, refreshRateHz }
  );
  assertTrue(
    pausedDelta !== null && pausedDelta <= 0.1,
    `Ambient loop CPU budget: paused excess over Artwork-only is at most 0.1s per 60s (actual ${pausedDelta}s)`,
    { fullPausedCpu, artworkPausedCpu, pausedDelta }
  );
}
