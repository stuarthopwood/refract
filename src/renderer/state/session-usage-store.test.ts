// Scope helpers of the Session usage store (#2070): which filters each toggle sends, and the cache key.
import { describe, expect, it, vi } from 'vitest'
import { effectiveScope, entryKey, scopeFilters, useSessionUsageStore, type SessionUsageTarget } from './session-usage-store'

const withConversation: SessionUsageTarget = { sessionDir: 'C:/s/a', sessionFile: 'C:/s/a/one.jsonl' }
const noConversation: SessionUsageTarget = { sessionDir: 'C:/s/a', sessionFile: null }

describe('scopeFilters', () => {
  it('session scope filters by the directory alone', () => {
    expect(scopeFilters(withConversation, 'session')).toEqual({ range: 'all', sessionDir: 'C:/s/a' })
  })

  it('conversation scope adds the conversation file, with no agent-type filter', () => {
    expect(scopeFilters(withConversation, 'conversation')).toEqual({
      range: 'all',
      sessionDir: 'C:/s/a',
      sessionFile: 'C:/s/a/one.jsonl'
    })
  })

  it('main agent scope adds the main agent type to the conversation file', () => {
    expect(scopeFilters(withConversation, 'main')).toEqual({
      range: 'all',
      sessionDir: 'C:/s/a',
      sessionFile: 'C:/s/a/one.jsonl',
      agentType: 'main'
    })
  })

  it('falls back to the session filters while there is no conversation file', () => {
    expect(scopeFilters(noConversation, 'main')).toEqual({ range: 'all', sessionDir: 'C:/s/a' })
    expect(scopeFilters(noConversation, 'conversation')).toEqual({ range: 'all', sessionDir: 'C:/s/a' })
  })
})

describe('effectiveScope', () => {
  it('keeps the chosen scope when a conversation exists', () => {
    expect(effectiveScope('main', withConversation)).toBe('main')
    expect(effectiveScope('conversation', withConversation)).toBe('conversation')
  })

  it('reads session when there is no conversation', () => {
    expect(effectiveScope('main', noConversation)).toBe('session')
  })
})

describe('entryKey', () => {
  it('gives conversation and main agent their own cache entries', () => {
    const keys = (['session', 'conversation', 'main'] as const).map((s) => entryKey(withConversation, s, 'all'))
    expect(new Set(keys).size).toBe(3)
  })

  it('shares one entry between every scope while there is no conversation', () => {
    const keys = (['session', 'conversation', 'main'] as const).map((s) => entryKey(noConversation, s, 'all'))
    expect(new Set(keys).size).toBe(1)
  })

  it('separates ranges', () => {
    expect(entryKey(withConversation, 'main', 'all')).not.toBe(entryKey(withConversation, 'main', 'today'))
  })
})

describe('refresh', () => {
  it('sends the scope filters, with the range, to every usage query', async () => {
    const ok = (value: unknown) => Promise.resolve({ ok: true, value })
    const summary = vi.fn(() => ok({ calls: 0 }))
    const usage = {
      getPrefs: () => ok({ sessionScope: 'main', sessionRange: 'all' }),
      summary,
      timeseries: vi.fn(() => ok([])),
      tokenMix: vi.fn(() => ok([])),
      breakdown: vi.fn(() => ok([])),
      calls: vi.fn(() => ok({ rows: [], total: 0 }))
    }
    ;(globalThis as unknown as { window: unknown }).window = { refract: { usage } }
    await useSessionUsageStore.getState().refresh(withConversation)
    expect(summary).toHaveBeenCalledWith({ ...scopeFilters(withConversation, 'main'), range: 'all' }, expect.any(Number))
    expect(usage.calls).toHaveBeenCalledWith(
      { ...scopeFilters(withConversation, 'main'), range: 'all' },
      expect.anything(),
      expect.anything(),
      expect.any(Number)
    )
  })
})
