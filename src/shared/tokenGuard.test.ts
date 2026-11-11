import { describe, expect, it } from 'vitest'
import { appliesToNewSessionsOnly, TOKEN_GUARD_KEYS } from './tokenGuard'

// The four keys OMP reloads into a running Session (#1765 probes); every other key waits for a new one.
const LIVE_KEYS = ['compaction.thresholdPercent', 'compaction.modelThresholds', 'compaction.methodOrder', 'tools.xdev']

describe('appliesToNewSessionsOnly', () => {
  it('is false for exactly the live keys', () => {
    const live = TOKEN_GUARD_KEYS.filter((info) => !appliesToNewSessionsOnly(info.key)).map((info) => info.key)
    expect(live.sort()).toEqual([...LIVE_KEYS].sort())
  })

  it('is true for every other key in the table', () => {
    for (const info of TOKEN_GUARD_KEYS) {
      if (!LIVE_KEYS.includes(info.key)) expect(appliesToNewSessionsOnly(info.key), info.key).toBe(true)
    }
  })

  it('is true for a key the table does not know', () => {
    expect(appliesToNewSessionsOnly('no.such.key')).toBe(true)
  })
})
