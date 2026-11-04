// Pure maths for the Averages section. Rust returns the counts; this only divides.
import type { UsageSummary } from '../../../shared/ipc-usage'

/** Spend per call, or null with no calls. Shared by the Averages card and the Session line. */
export const spendPerCall = (summary: UsageSummary): number | null => divide(summary.spendUsd, summary.calls)

export interface Averages {
  spendPerDay: number | null
  creditsPerDay: number | null
  callsPerDay: number | null
  spendPerCall: number | null
  spendPerSession: number | null
  projectedMonth: number | null
}

const divide = (n: number, d: number): number | null => (d > 0 ? n / d : null)

/** Monday to Friday days after `today` through the end of its local month. */
export function weekdaysLeft(today: Date): number {
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  let count = 0
  for (let day = today.getDate() + 1; day <= last; day += 1) {
    const dow = new Date(today.getFullYear(), today.getMonth(), day).getDay()
    if (dow !== 0 && dow !== 6) count += 1
  }
  return count
}

export function computeAverages(summary: UsageSummary, today: Date): Averages {
  const perActiveDay = divide(summary.monthToDateUsd, summary.monthActiveDays)
  return {
    spendPerDay: divide(summary.spendUsd, summary.activeDays),
    creditsPerDay: divide(summary.credits, summary.activeDays),
    callsPerDay: divide(summary.calls, summary.activeDays),
    spendPerCall: spendPerCall(summary),
    spendPerSession: divide(summary.spendUsd, summary.sessions),
    projectedMonth: perActiveDay === null ? null : summary.monthToDateUsd + perActiveDay * weekdaysLeft(today)
  }
}
