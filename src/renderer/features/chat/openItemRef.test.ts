// Issue #1950: the click decision for a chat `#123` reference. Each case names the guard it pins.
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { ItemCard } from '../../../shared/ipc-item-refs'
import type { ItemRefTarget } from './itemRefs'
import { openItemRef, wantsBrowser, type OpenItemRefDeps } from './openItemRef'

const TARGET: ItemRefTarget = { repositoryId: 'repo-1', owner: null, repo: null, number: 12, inProject: true }
const CARD: ItemCard = {
  ownerRepo: 'me/app',
  number: 12,
  kind: 'issue',
  title: 'T',
  state: 'open',
  draft: false,
  url: 'https://github.com/me/app/issues/12',
  createdAt: '2026-11-01T00:00:00Z',
  authorLogin: 'me',
  avatarDataUrl: null,
  baseRef: null,
  headRef: null
}
const OPENER = { tagName: 'BUTTON' } as unknown as HTMLElement

interface SpyDeps extends OpenItemRefDeps {
  lookup: Mock<OpenItemRefDeps['lookup']>
  pin: Mock<OpenItemRefDeps['pin']>
  openUrl: Mock<OpenItemRefDeps['openUrl']>
}

function deps(card: ItemCard | null): SpyDeps {
  return { lookup: vi.fn(async () => card), pin: vi.fn(), openUrl: vi.fn() }
}

const base = { target: TARGET, sessionId: 'session-1', opener: OPENER, toBrowser: false, ownerRepo: 'me/app' }

describe('openItemRef', () => {
  it('pins an in-Project issue without taking focus', async () => {
    const d = deps(CARD)
    await openItemRef(base, d)
    expect(d.pin).toHaveBeenCalledWith('issue', { repositoryId: 'repo-1', number: 12, sessionId: 'session-1', opener: OPENER, focus: false })
    expect(d.openUrl).not.toHaveBeenCalled()
  })

  it('pins a pull request as a pull request', async () => {
    const d = deps({ ...CARD, kind: 'pull-request' })
    await openItemRef(base, d)
    expect(d.pin).toHaveBeenCalledWith('pull-request', expect.objectContaining({ number: 12, focus: false }))
  })

  it('opens GitHub on a modifier or middle click without a lookup or a pin', async () => {
    const d = deps(CARD)
    await openItemRef({ ...base, toBrowser: true }, d)
    expect(d.openUrl).toHaveBeenCalledWith('https://github.com/me/app/issues/12')
    expect(d.lookup).not.toHaveBeenCalled()
    expect(d.pin).not.toHaveBeenCalled()
  })

  it('opens GitHub when the lookup fails', async () => {
    const d = deps(null)
    await openItemRef(base, d)
    expect(d.openUrl).toHaveBeenCalledWith('https://github.com/me/app/issues/12')
    expect(d.pin).not.toHaveBeenCalled()
  })

  it('opens GitHub, not the pane, for a repository that is not the Project', async () => {
    const d = deps({ ...CARD, ownerRepo: 'other/lib', url: 'https://github.com/other/lib/pull/12' })
    await openItemRef({ ...base, target: { ...TARGET, owner: 'other', repo: 'lib', inProject: false }, ownerRepo: 'other/lib' }, d)
    expect(d.openUrl).toHaveBeenCalledWith('https://github.com/other/lib/pull/12')
    expect(d.pin).not.toHaveBeenCalled()
  })

  it('does nothing when the lookup fails and the Project has no GitHub remote', async () => {
    const d = deps(null)
    await openItemRef({ ...base, ownerRepo: null }, d)
    expect(d.openUrl).not.toHaveBeenCalled()
    expect(d.pin).not.toHaveBeenCalled()
  })
})

describe('wantsBrowser', () => {
  it('is true for Ctrl, Cmd and the middle button only', () => {
    expect(wantsBrowser({ ctrlKey: true, metaKey: false, button: 0 })).toBe(true)
    expect(wantsBrowser({ ctrlKey: false, metaKey: true, button: 0 })).toBe(true)
    expect(wantsBrowser({ ctrlKey: false, metaKey: false, button: 1 })).toBe(true)
    expect(wantsBrowser({ ctrlKey: false, metaKey: false, button: 0 })).toBe(false)
  })
})
