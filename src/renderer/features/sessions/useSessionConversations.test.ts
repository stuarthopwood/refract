// The hook itself needs a DOM to run; the rule that matters, that an older response never overwrites a newer one,
// lives in the guard, so it is tested on its own.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStaleGuard, readConversations } from './useSessionConversations'

function stubList(list: () => Promise<unknown>) {
  vi.stubGlobal('window', { refract: { conversations: { list } } })
}

afterEach(() => vi.unstubAllGlobals())

describe('readConversations', () => {
  it('Given the list call rejects, When read, Then it reports the failure instead of throwing', async () => {
    stubList(() => Promise.reject(new Error('channel closed')))
    await expect(readConversations('s1')).resolves.toEqual({ ok: false, message: 'channel closed' })
  })

  it('Given the list call rejects with a non-Error, When read, Then the message is its string form', async () => {
    stubList(() => Promise.reject('gone'))
    await expect(readConversations('s1')).resolves.toEqual({ ok: false, message: 'gone' })
  })

  it('Given a refused read, When read, Then the refusal message is reported', async () => {
    stubList(() => Promise.resolve({ ok: false, error: { code: 'internal', message: 'no folder' } }))
    await expect(readConversations('s1')).resolves.toEqual({ ok: false, message: 'no folder' })
  })

  it('Given a successful read, When read, Then the Conversations are returned', async () => {
    stubList(() => Promise.resolve({ ok: true, value: [] }))
    await expect(readConversations('s1')).resolves.toEqual({ ok: true, value: [] })
  })
})

describe('createStaleGuard', () => {
  it('Given two overlapping requests, When the older one resolves last, Then only the newer ticket is current', () => {
    const guard = createStaleGuard()
    const older = guard.next()
    const newer = guard.next()
    expect(guard.isCurrent(older)).toBe(false)
    expect(guard.isCurrent(newer)).toBe(true)
  })

  it('Given a lone request, When it resolves, Then its ticket is current until the next request starts', () => {
    const guard = createStaleGuard()
    const ticket = guard.next()
    expect(guard.isCurrent(ticket)).toBe(true)
    guard.next()
    expect(guard.isCurrent(ticket)).toBe(false)
  })
})
