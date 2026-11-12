import { describe, expect, it } from 'vitest'
import { countPausedIdle, isIdleStoppable } from './triageSessions'

const idle = { status: 'idle', archivedAt: null } as const

describe('isIdleStoppable', () => {
  it('accepts an idle, unpaused, unarchived Session', () => {
    expect(isIdleStoppable(idle)).toBe(true)
  })

  it('refuses a paused Session even though its turn finished', () => {
    expect(isIdleStoppable({ ...idle, pause: 'paused' })).toBe(false)
  })

  it('refuses a working, stopped or archived Session', () => {
    expect(isIdleStoppable({ ...idle, status: 'working' })).toBe(false)
    expect(isIdleStoppable({ ...idle, status: 'stopped' })).toBe(false)
    expect(isIdleStoppable({ ...idle, archivedAt: '2026-11-12T00:00:00Z' })).toBe(false)
  })
})

describe('countPausedIdle', () => {
  it('counts only idle, unarchived, paused Sessions', () => {
    const sessions = [
      idle,
      { ...idle, pause: 'paused' as const },
      { ...idle, pause: 'paused' as const },
      { ...idle, status: 'stopped' as const, pause: 'paused' as const },
      { ...idle, archivedAt: '2026-11-12T00:00:00Z', pause: 'paused' as const }
    ]
    expect(countPausedIdle(sessions)).toBe(2)
  })

  it('is zero when nothing is paused', () => {
    expect(countPausedIdle([idle])).toBe(0)
  })
})
