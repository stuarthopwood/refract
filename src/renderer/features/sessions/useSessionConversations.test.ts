// The hook itself needs a DOM to run; the rule that matters, that an older response never overwrites a newer one,
// lives in the guard, so it is tested on its own.
import { describe, expect, it } from 'vitest'
import { createStaleGuard } from './useSessionConversations'

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
