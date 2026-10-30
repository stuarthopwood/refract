
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
