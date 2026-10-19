// Issue #1048 (Holiday touches): resolves "today" for `shared/holidays.ts::activeHoliday` at
// startup, and keeps it correct for the rest of the run -- the debug-only date override
// (`REFRACT_DATE_OVERRIDE`, read via `window.refract.debug.getOverrides()`, itself gated
// `#[cfg(debug_assertions)]` in Rust, so this call is always inert in a release build) never
// changes while the app is running, but the REAL calendar date can roll over mid-session (a
// Session left open past local midnight) -- a one-shot resolve at startup alone would leave
// that session showing yesterday's holiday (or none) until the next full reload. Gate round 1
// fix (High, #1053): re-resolved on a timer at the next local midnight, and again on
// `visibilitychange`/`focus` (catches a sleeping machine whose clock jumped while the window was
// hidden). `idleTimeoutMs` is read by `HolidayAmbientLoop.tsx` for the same override reason: a
// live check can shorten the ambient loop's 60s no-input pause without waiting a full minute.
import { create } from 'zustand'
import { activeHoliday } from '../../shared/holidays'
import type { HolidayId } from '../../shared/holidays'

export const HOLIDAY_IDLE_PAUSE_MS_DEFAULT = 60_000

interface HolidayState {
  /** The debug-only date override (`YYYY-MM-DD`), or `null` for the real system date -- kept
   * here (not just closed over) so the midnight/visibility re-resolve below can recompute
   * against the SAME override every time, not just the real clock. */
  dateOverride: string | null
  idleTimeoutMs: number
  activeHoliday: HolidayId | null
}

function resolveActiveHoliday(dateOverride: string | null): HolidayId | null {
  const date = dateOverride ? new Date(`${dateOverride}T12:00:00`) : new Date()
  return activeHoliday(date)
}

export const useHolidayStore = create<HolidayState>(() => ({
  dateOverride: null,
  idleTimeoutMs: HOLIDAY_IDLE_PAUSE_MS_DEFAULT,
  activeHoliday: resolveActiveHoliday(null)
}))

function reresolveActiveHoliday(): void {
  const { dateOverride, activeHoliday: current } = useHolidayStore.getState()
  const next = resolveActiveHoliday(dateOverride)
  if (next !== current) useHolidayStore.setState({ activeHoliday: next })
}

/** A few seconds past midnight (not exactly on it): avoids a clock-precision race where the
 * timer fires a moment before the new day's own `Date.now()` would actually report it. */
const MIDNIGHT_RERESOLVE_MARGIN_MS = 5_000

function scheduleNextMidnightReresolve(): void {
  const now = new Date()
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, MIDNIGHT_RERESOLVE_MARGIN_MS)
  const delayMs = nextMidnight.getTime() - now.getTime()
  window.setTimeout(() => {
    reresolveActiveHoliday()
    scheduleNextMidnightReresolve()
  }, delayMs)
}

/** Called once from `init-stores.ts`'s own bootstrap sequence. A failed/unsupported
 * `debug.getOverrides` call (the `Result` envelope's `ok: false`, same shape every other initial
 * load in that file already handles) is treated exactly like a release build's always-inert
 * reply: no override, no shortened idle timeout. Also arms the ongoing re-resolve triggers
 * (midnight timer, `visibilitychange`, `focus`) for the rest of the app's run. */
export async function initHolidayOverrides(): Promise<void> {
  const result = await window.refract.debug.getOverrides()
  const dateOverride = result.ok ? result.value.date : null
  const idleTimeoutMs = (result.ok ? result.value.idleTimeoutMs : null) ?? HOLIDAY_IDLE_PAUSE_MS_DEFAULT
  useHolidayStore.setState({
    dateOverride,
    idleTimeoutMs,
    activeHoliday: resolveActiveHoliday(dateOverride)
  })
  scheduleNextMidnightReresolve()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reresolveActiveHoliday()
  })
  window.addEventListener('focus', reresolveActiveHoliday)
}
