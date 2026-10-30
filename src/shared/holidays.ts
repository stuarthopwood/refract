/** Pure holiday calendar: a local date maps to at most one active holiday. Callers pass a real
 * `Date`, read via LOCAL `getMonth()`/`getDate()`; windows include both ends. The debug "today"
 * override is resolved by holiday-store.ts, so this module never reads env or `window` (#1048). */

export type HolidayId = 'halloween' | 'bonfire-night' | 'christmas' | 'new-year' | 'star-wars-day' | 'pi-day';

/** Only holidays marked `true` (live-verified) are active in production; `activeHoliday` never returns others. */
export const VERIFIED_HOLIDAYS: Record<HolidayId, boolean> = {
  halloween: true,
  'bonfire-night': true,
  christmas: true,
  'new-year': true,
  'star-wars-day': true,
  'pi-day': true
};

interface MonthDay {
  month: number; // 1-12
  day: number; // 1-31
}

interface HolidayWindow {
  id: HolidayId;
  start: MonthDay;
  end: MonthDay;
}

/** The six windows; New Year's `start` (31 Dec) is after its `end` (1 Jan), the only year-wrapping one. */
export const HOLIDAY_WINDOWS: readonly HolidayWindow[] = [
  { id: 'halloween', start: { month: 10, day: 24 }, end: { month: 10, day: 31 } },
  { id: 'bonfire-night', start: { month: 11, day: 1 }, end: { month: 11, day: 5 } },
  { id: 'christmas', start: { month: 12, day: 1 }, end: { month: 12, day: 26 } },
  { id: 'new-year', start: { month: 12, day: 31 }, end: { month: 1, day: 1 } },
  { id: 'star-wars-day', start: { month: 5, day: 4 }, end: { month: 5, day: 4 } },
  { id: 'pi-day', start: { month: 3, day: 14 }, end: { month: 3, day: 14 } }
];

function monthDayToOrdinal(value: MonthDay): number {
  // Non-leap table is enough: no window uses Feb 29.
  const CUMULATIVE_DAYS_BEFORE_MONTH: readonly [number, number, number, number, number, number, number, number, number, number, number, number] =
    [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  // `?? 0` only satisfies noUncheckedIndexedAccess; the month is always 1-12.
  return (CUMULATIVE_DAYS_BEFORE_MONTH[value.month - 1] ?? 0) + value.day;
}

/** Inclusive window length in days (the overlap tiebreak); wrapping windows add 365. */
function windowLengthDays(win: HolidayWindow): number {
  const startOrdinal = monthDayToOrdinal(win.start);
  const endOrdinal = monthDayToOrdinal(win.end);
  const span = endOrdinal >= startOrdinal ? endOrdinal - startOrdinal : endOrdinal + 365 - startOrdinal;
  return span + 1;
}

function isWithinWindow(ordinal: number, win: HolidayWindow): boolean {
  const startOrdinal = monthDayToOrdinal(win.start);
  const endOrdinal = monthDayToOrdinal(win.end);
  if (endOrdinal >= startOrdinal) return ordinal >= startOrdinal && ordinal <= endOrdinal;
  // Wrapping window (New Year): "inside" means on-or-after start OR on-or-before end.
  return ordinal >= startOrdinal || ordinal <= endOrdinal;
}

/** The active, verified holiday for `date`'s local day, else `null`. The shortest overlapping window
 * wins (ties by declaration order); verification is applied after picking, so an unverified
 * winner yields `null` rather than handing the day to a verified runner-up. */
export function activeHoliday(date: Date): HolidayId | null {
  const ordinal = monthDayToOrdinal({ month: date.getMonth() + 1, day: date.getDate() });
  let best: HolidayWindow | null = null;
  for (const candidate of HOLIDAY_WINDOWS) {
    if (!isWithinWindow(ordinal, candidate)) continue;
    if (!best || windowLengthDays(candidate) < windowLengthDays(best)) best = candidate;
  }
  if (!best || !VERIFIED_HOLIDAYS[best.id]) return null;
  return best.id;
}
