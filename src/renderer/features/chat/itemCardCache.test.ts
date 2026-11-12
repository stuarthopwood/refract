// Issue #1950 / #610: render may read the cache but never starts a lookup; failures never stick.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ItemCard } from '../../../shared/ipc-item-refs'
import { clearCardCache, lookupCard, peekCard } from './itemCardCache'
import type { ItemRefTarget } from './itemRefs'

const TARGET: ItemRefTarget = { repositoryId: 'repo-1', owner: null, repo: null, number: 7, inProject: true }
const CARD: ItemCard = {
  ownerRepo: 'me/app',
  number: 7,
  kind: 'pull-request',
  title: 'T',
  state: 'open',
  draft: false,
  url: 'https://github.com/me/app/pull/7',
  createdAt: '2026-11-01T00:00:00Z',
  authorLogin: 'me',
  avatarDataUrl: null,
  baseRef: 'main',
  headRef: 'feat'
}

const lookup = vi.fn()

beforeEach(() => {
  clearCardCache()
  lookup.mockReset()
  vi.stubGlobal('window', { refract: { itemRefs: { lookup } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('peekCard', () => {
  it('is undefined and starts no lookup before anything was looked up', () => {
    expect(peekCard(TARGET)).toBeUndefined()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('returns the resolved card without a second lookup', async () => {
    lookup.mockResolvedValue({ ok: true, value: CARD })
    await lookupCard(TARGET)
    expect(peekCard(TARGET)).toEqual(CARD)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('is undefined for a failed lookup, which is not cached', async () => {
    lookup.mockResolvedValue({ ok: false, error: 'no access' })
    await lookupCard(TARGET)
    expect(peekCard(TARGET)).toBeUndefined()
    lookup.mockResolvedValue({ ok: true, value: CARD })
    await lookupCard(TARGET)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('is undefined once the five-minute window has passed', async () => {
    vi.useFakeTimers()
    try {
      lookup.mockResolvedValue({ ok: true, value: CARD })
      await lookupCard(TARGET)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      expect(peekCard(TARGET)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
