import { describe, expect, it } from 'vitest'
import type { TokenGuardTrigger } from '../../../../shared/tokenGuard'
import { formatTriggerLine } from './formatTriggerLine'

const base: TokenGuardTrigger = { model: 'p/m', contextWindow: 200000, thresholdPercent: 70, triggerTokens: 140000 }

describe('formatTriggerLine', () => {
  it('names the global percent when the model has no threshold of its own', () => {
    expect(formatTriggerLine(base)).toBe('p/m: 140,000 tokens (70% global of 200,000)')
  })

  it('shows a per-model percent as written', () => {
    expect(formatTriggerLine({ ...base, modelThreshold: '80%', triggerTokens: 160000 })).toBe('p/m: 160,000 tokens (80% per-model of 200,000)')
  })

  it('reads a bare per-model number up to 99 as a percent, as OMP does', () => {
    expect(formatTriggerLine({ ...base, modelThreshold: 80, triggerTokens: 160000 })).toBe('p/m: 160,000 tokens (80% per-model of 200,000)')
  })

  it('formats a per-model token count with thousands separators', () => {
    expect(formatTriggerLine({ ...base, modelThreshold: 120000, triggerTokens: 120000 })).toBe('p/m: 120,000 tokens (120,000 per-model of 200,000)')
  })
})
