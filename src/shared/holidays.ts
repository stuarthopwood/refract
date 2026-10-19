/** Issue #1048 (Holiday touches): the pure holiday calendar -- one local date maps to AT MOST
 * ONE active holiday (grill decision 4). No network, no locale guessing: the caller always
 * passes a real `Date`, read with its LOCAL `getMonth()`/`getDate()` (never UTC), matching "the
 * date is the local system date" from the issue body. Every window is inclusive of both its
 * start and end day. `activeHoliday` is the one exported entry point every call site (the
 * watermark, start messages, sidebar accessory, empty states, the spinner glyph, the ambient
 * loop) uses, so the six windows below are declared in exactly one place.
 *
 * Debug-only "today" override: `src/renderer/state/holiday-store.ts` resolves the actual `Date`
 * passed in here (real system date, or the debug build's `REFRACT_DATE_OVERRIDE` env var via
 * `debug.getOverrides`) -- this module itself never reads an env var or touches `window`, so it
 * stays a plain, synchronously-testable pure function regardless of which build calls it. */

export type HolidayId = 'halloween' | 'bonfire-night' | 'christmas' | 'new-year' | 'star-wars-day' | 'pi-day';

interface MonthDay {
  month: number; // 1-12
  day: number; // 1-31
}

interface HolidayWindow {
  id: HolidayId;
  name: string;
  start: MonthDay;
  end: MonthDay;
}

/** Grill decision 4's six windows, verbatim. New Year's own `start` (31 Dec) is later in the
 * calendar year than its `end` (1 Jan) -- the one wrapping-over-year-boundary window -- every
 * other window's `start` sorts before its `end` within the same year. */
export const HOLIDAY_WINDOWS: readonly HolidayWindow[] = [
  { id: 'halloween', name: 'Halloween', start: { month: 10, day: 24 }, end: { month: 10, day: 31 } },
  { id: 'bonfire-night', name: 'Bonfire Night', start: { month: 11, day: 1 }, end: { month: 11, day: 5 } },
  { id: 'christmas', name: 'Christmas', start: { month: 12, day: 1 }, end: { month: 12, day: 26 } },
  { id: 'new-year', name: 'New Year', start: { month: 12, day: 31 }, end: { month: 1, day: 1 } },
  { id: 'star-wars-day', name: 'Star Wars Day', start: { month: 5, day: 4 }, end: { month: 5, day: 4 } },
  { id: 'pi-day', name: 'Pi Day', start: { month: 3, day: 14 }, end: { month: 3, day: 14 } }
];

function monthDayToOrdinal(value: MonthDay): number {
  // A fixed non-leap-year day-of-year table is enough here: every window's own month/day pair
  // is a literal constant above, never Feb 29, so leap years never change which ordinal a
  // boundary maps to.
  const CUMULATIVE_DAYS_BEFORE_MONTH: readonly [number, number, number, number, number, number, number, number, number, number, number, number] =
    [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  // `value.month` is always 1-12 (every `MonthDay` literal above is a real calendar date), so
  // this index is always in range; the `?? 0` only satisfies `noUncheckedIndexedAccess`, which
  // cannot see that invariant from a runtime-computed index into a tuple.
  return (CUMULATIVE_DAYS_BEFORE_MONTH[value.month - 1] ?? 0) + value.day;
}

/** Window length in days, inclusive of both ends -- the "shorter window wins" overlap tiebreak
 * (grill decision 4's own proposal) measures this, not the raw calendar distance between two
 * windows that do not actually overlap. Wrapping windows (`end` earlier in the year than
 * `start`, i.e. New Year) add 365 before subtracting so the length comes out positive. */
function windowLengthDays(window: HolidayWindow): number {
  const startOrdinal = monthDayToOrdinal(window.start);
  const endOrdinal = monthDayToOrdinal(window.end);
  const span = endOrdinal >= startOrdinal ? endOrdinal - startOrdinal : endOrdinal + 365 - startOrdinal;
  return span + 1;
}

function isWithinWindow(ordinal: number, window: HolidayWindow): boolean {
  const startOrdinal = monthDayToOrdinal(window.start);
  const endOrdinal = monthDayToOrdinal(window.end);
  if (endOrdinal >= startOrdinal) return ordinal >= startOrdinal && ordinal <= endOrdinal;
  // Wrapping window (New Year): "inside" means on-or-after start OR on-or-before end.
  return ordinal >= startOrdinal || ordinal <= endOrdinal;
}

/** The one active holiday for `date`'s local day, or `null` outside every window. None of the
 * six windows above actually overlap today (each sits in its own disjoint stretch of the
 * calendar), so "shorter window wins" never fires in practice yet -- it exists defensively, for
 * whichever holiday is added next to a month that already has one (grill decision 4's own
 * wording: "If windows ever overlap ... shorter window wins"). A tie in length falls back to
 * declaration order in `HOLIDAY_WINDOWS` (deterministic, never Math.random). */
export function activeHoliday(date: Date): HolidayId | null {
  const ordinal = monthDayToOrdinal({ month: date.getMonth() + 1, day: date.getDate() });
  let best: HolidayWindow | null = null;
  for (const window of HOLIDAY_WINDOWS) {
    if (!isWithinWindow(ordinal, window)) continue;
    if (!best || windowLengthDays(window) < windowLengthDays(best)) best = window;
  }
  return best?.id ?? null;
}
