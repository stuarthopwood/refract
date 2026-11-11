import { describe, expect, it } from 'vitest'
import { costShareSortValue, formatPercent } from './format'

describe('formatPercent for a cost share', () => {
  it('formats a fraction of spend as a percentage', () => {
    expect(formatPercent(0.25)).toBe('25%')
    expect(formatPercent(0.045)).toBe('4.5%')
  })

  it('shows 0% for a tool that cost nothing when others were priced', () => {
    expect(formatPercent(0)).toBe('0%')
  })
})

describe('costShareSortValue', () => {
  it('ranks an unpriced row below a priced 0%', () => {
    expect(costShareSortValue(undefined)).toBeLessThan(costShareSortValue(0))
  })

  it('sorts unpriced rows last descending and first ascending', () => {
    const rows = [{ share: 0.5 }, { share: undefined }, { share: 0 }]
    const asc = [...rows].sort((a, b) => costShareSortValue(a.share) - costShareSortValue(b.share))
    expect(asc.map((r) => r.share)).toEqual([undefined, 0, 0.5])
    const desc = [...rows].sort((a, b) => costShareSortValue(b.share) - costShareSortValue(a.share))
    expect(desc.map((r) => r.share)).toEqual([0.5, 0, undefined])
  })
})
