import { describe, expect, it } from 'vitest'
import { formatCostShare } from './format'

describe('formatCostShare', () => {
  it('formats a fraction of spend as a percentage', () => {
    expect(formatCostShare(0.25)).toBe('25%')
    expect(formatCostShare(0.045)).toBe('4.5%')
  })

  it('shows an em dash when the window has no priced calls', () => {
    expect(formatCostShare(undefined)).toBe('—')
  })

  it('shows 0% for a tool that cost nothing when others were priced', () => {
    expect(formatCostShare(0)).toBe('0%')
  })
})
