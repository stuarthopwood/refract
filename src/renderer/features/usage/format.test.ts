import { describe, expect, it } from 'vitest'
import { UNPRICED_RANK, costShareSortValue, formatPercent } from './format'

describe('formatPercent for a cost share', () => {
  it('formats a fraction of spend as a percentage', () => {
    expect(formatPercent(0.25)).toBe('25%')
    expect(formatPercent(0.04)).toBe('4.0%')
  })

  it('shows 0% for a tool that cost nothing when others were priced', () => {
    expect(formatPercent(0)).toBe('0%')
  })
})

describe('costShareSortValue', () => {
  it('ranks an unpriced row below a priced 0%', () => {
    expect(costShareSortValue(undefined)).toBe(UNPRICED_RANK)
    expect(costShareSortValue(undefined)).toBeLessThan(costShareSortValue(0))
  })
})
