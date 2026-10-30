import { create } from 'zustand'
import { activeHoliday } from '../../shared/holidays'
import type { HolidayId } from '../../shared/holidays'

export const HOLIDAY_IDLE_PAUSE_MS_DEFAULT = 60_000

interface HolidayState {
  dateOverride: string | null
  idleTimeoutMs: number
  flightIntervalMs: number | null
  activeHoliday: HolidayId | null
}

function resolveActiveHoliday(dateOverride: string | null): HolidayId | null {
  const date = dateOverride ? new Date(`${dateOverride}T12:00:00`) : new Date()
  return activeHoliday(date)
}

export const useHolidayStore = create<HolidayState>(() => ({
  dateOverride: null,
  idleTimeoutMs: HOLIDAY_IDLE_PAUSE_MS_DEFAULT,
  flightIntervalMs: null,
  activeHoliday: resolveActiveHoliday(null)
}))

function reresolveActiveHoliday(): void {
  const { dateOverride, activeHoliday: current } = useHolidayStore.getState()
  const next = resolveActiveHoliday(dateOverride)
  if (next !== current) useHolidayStore.setState({ activeHoliday: next })
}

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

/** Called once from `init-stores.ts`'s own bootstrap sequence. */
export async function initHolidayOverrides(): Promise<void> {
  const result = await window.refract.debug.getOverrides()
  const dateOverride = result.ok ? result.value.date : null
  const idleTimeoutMs = (result.ok ? result.value.idleTimeoutMs : null) ?? HOLIDAY_IDLE_PAUSE_MS_DEFAULT
  const flightIntervalMs = result.ok ? result.value.flightIntervalMs : null
  useHolidayStore.setState({
    dateOverride,
    idleTimeoutMs,
    flightIntervalMs,
    activeHoliday: resolveActiveHoliday(dateOverride)
  })
  scheduleNextMidnightReresolve()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reresolveActiveHoliday()
  })
  window.addEventListener('focus', reresolveActiveHoliday)
}
