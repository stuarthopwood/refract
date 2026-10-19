// Issue #1048 (Holiday touches): resolves "today" for `shared/holidays.ts::activeHoliday` once
// at startup and caches the result -- the debug-only date override (`REFRACT_DATE_OVERRIDE`,
// read via `window.refract.debug.getOverrides()`, itself gated `#[cfg(debug_assertions)]` in
// Rust, so this call is always inert in a release build) never changes while the app is
// running, so there is no listener/timer here, just a one-shot resolve mirroring
// `init-stores.ts`'s own `settings.get`/`repositories.list` bootstrap loads. `idleTimeoutMs`
// is read by `HolidayAmbientLoop.tsx` for the same reason: a live check can shorten the ambient
// loop's 60s no-input pause without waiting a full minute.
import { create } from 'zustand'
import { activeHoliday } from '../../shared/holidays'
import type { HolidayId } from '../../shared/holidays'

export const HOLIDAY_IDLE_PAUSE_MS_DEFAULT = 60_000

interface HolidayState {
  /** `null` until `initHolidayOverrides()` resolves; every reader treats "not yet resolved" the
   * same as "no override" (falls back to the real system date) -- the one-frame window before
   * this resolves is never user-visible (holiday artwork is decorative, never gating anything
   * functional). */
  resolved: boolean
  dateOverride: string | null
  idleTimeoutMs: number
  activeHoliday: HolidayId | null
}

function resolveActiveHoliday(dateOverride: string | null): HolidayId | null {
  const date = dateOverride ? new Date(`${dateOverride}T12:00:00`) : new Date()
  return activeHoliday(date)
}

export const useHolidayStore = create<HolidayState>(() => ({
  resolved: false,
  dateOverride: null,
  idleTimeoutMs: HOLIDAY_IDLE_PAUSE_MS_DEFAULT,
  activeHoliday: resolveActiveHoliday(null)
}))

/** Called once from `init-stores.ts`'s own bootstrap sequence. A failed/unsupported call (the
 * `Result` envelope's `ok: false`, same shape every other initial load in that file already
 * handles) is treated exactly like a release build's always-inert reply: no override, no
 * shortened idle timeout. */
export async function initHolidayOverrides(): Promise<void> {
  const result = await window.refract.debug.getOverrides()
  const dateOverride = result.ok ? result.value.date : null
  const idleTimeoutMs = (result.ok ? result.value.idleTimeoutMs : null) ?? HOLIDAY_IDLE_PAUSE_MS_DEFAULT
  useHolidayStore.setState({
    resolved: true,
    dateOverride,
    idleTimeoutMs,
    activeHoliday: resolveActiveHoliday(dateOverride)
  })
}
