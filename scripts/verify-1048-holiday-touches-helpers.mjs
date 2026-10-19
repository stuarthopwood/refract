// Helpers for scripts/verify-1048-holiday-touches.mjs, split out to keep that file under the
// 600-line soft cap (issue #806) once gate round 1's fixes (CPU-tree measurement, screenshot
// hygiene) were added.
import { spawnSync } from 'node:child_process';

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
 * idle-timer firing. */
export async function dispatchNeutralPointerdown(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 400, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 400, button: 'left', clickCount: 1 });
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
