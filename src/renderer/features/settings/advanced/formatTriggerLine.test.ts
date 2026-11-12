import { describe, expect, it } from 'vitest'
import type { TokenGuardTrigger } from '../../../../shared/tokenGuard'
import { formatTriggerLine } from './formatTriggerLine'

const base: TokenGuardTrigger = { model: 'p/m', contextWindow: 200000, thresholdPercent: 70, triggerTokens: 140000 }
const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')

describe('formatTriggerLine', () => {
  it('names the global percent when the model has no threshold of its own', () => {
    expect(formatTriggerLine(base)).toBe('p/m: 140,000 tokens (70% global of 200,000)')
  })

  it('shows a per-model percent as written', () => {
    expect(formatTriggerLine({ ...base, modelThreshold: '80%', triggerTokens: 160000 })).toBe('p/m: 160,000 tokens (80% per-model of 200,000)')
  })

  it('formats a per-model token count with thousands separators', () => {
    expect(nbsp(formatTriggerLine({ ...base, modelThreshold: 120000, triggerTokens: 120000 }))).toBe('p/m: 120,000 tokens (120,000 per-model of 200,000)')
  })
})
