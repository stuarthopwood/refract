// Shared compact-number formatter (issue #437; 2026-10-05 decision, refined by the 2026-10-15
// grill): one lower-case k/m/b formatter used by the Changes Readout, the Context usage Readout,
// and the Session details card's own diff line (`sessionDisplay.tsx`'s `formatDiffStat`), so the
// hover card and the status line never show the same figure two different ways. Replaces the old
// `Intl.NumberFormat(..., { notation: 'compact' })` helper `Readouts.tsx` used only for the
// Changes chip, which was upper-case (`K`/`M`/`B`) and rounded without a fixed decimal count.
//
// Rule: plain below 1,000. From 1,000 up, abbreviate with a lower-case suffix (English
// regardless of system locale), at most one decimal, a trailing zero dropped (`1m`, never
// `1.0m`), rounded half up. Rounding to one decimal can reach 1,000 of the current tier (for
// example 999,950 -> 999.95k rounds to 1000.0k) -- that case carries into the next larger tier
// instead of printing a four-digit mantissa (999,950 reads `1m`, never `1000k`).

const TIERS = [
  { value: 1_000_000_000, suffix: 'b' },
  { value: 1_000_000, suffix: 'm' },
  { value: 1_000, suffix: 'k' }
] as const

function mantissa(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function compactNumber(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 1000) return `${sign}${Math.round(abs)}`
  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i]!
    if (abs < tier.value) continue
    const rounded = Math.round((abs / tier.value) * 10) / 10
    if (rounded >= 1000 && i > 0) {
      const bigger = TIERS[i - 1]!
      return `${sign}${mantissa(Math.round((abs / bigger.value) * 10) / 10)}${bigger.suffix}`
    }
    return `${sign}${mantissa(rounded)}${tier.suffix}`
  }
  return `${sign}${Math.round(abs)}`
}
