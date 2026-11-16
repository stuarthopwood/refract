// Issue #1950 / #610: a ref link renders a neutral icon and starts no lookup until it is hovered,
// focused or clicked; a cached lookup shows the type at once. The repo has no jsdom, so it renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ItemCard } from '../../../shared/ipc-item-refs'

const mocks = vi.hoisted(() => {
  const repository = { id: 'repo-1', remote: { kind: 'has', owner: 'me', repo: 'app' } }
  const state = { sessions: [{ id: 'sess-1', repositoryId: 'repo-1' }], repositories: [repository] }
  const store = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state })
  return { store }
})
vi.mock('@/state', () => ({ useSessionsStore: mocks.store, useRepositoriesStore: mocks.store, usePinnedPanelsStore: mocks.store }))

import { clearCardCache, lookupCard } from './itemCardCache'
import { ItemCardBody, ItemRefLink } from './ItemRefLink'

const CARD: ItemCard = {
  ownerRepo: 'me/app',
  number: 5,
  kind: 'issue',
  title: 'T',
  state: 'open',
  draft: false,
  url: 'https://github.com/me/app/issues/5',
  createdAt: '2026-11-01T00:00:00Z',
  authorLogin: 'me',
  avatarDataUrl: null,
  baseRef: null,
  headRef: null
}
const lookup = vi.fn()
const render = (text: string, streaming = false) => renderToStaticMarkup(createElement(ItemRefLink, { text, sessionId: 'sess-1', streaming }))

beforeEach(() => {
  clearCardCache()
  lookup.mockReset()
  vi.stubGlobal('window', { refract: { itemRefs: { lookup } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('ItemRefLink render', () => {
  it('shows the neutral icon and starts no lookup before the link is used', () => {
    const html = render('#5')
    expect(html).toContain('data-item-type="unknown"')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('shows the type icon at once for an item already looked up', async () => {
    lookup.mockResolvedValue({ ok: true, value: CARD })
    await lookupCard({ repositoryId: 'repo-1', owner: null, repo: null, number: 5, inProject: true })
    expect(render('#5')).toContain('data-item-type="issue"')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('stays inert text with no icon while streaming', () => {
    expect(render('#5', true)).not.toContain('data-item-type')
  })

  it('adds the type word to the link name once the type is known, and not before', async () => {
    expect(render('#5')).not.toContain('Pull request')
    lookup.mockResolvedValue({ ok: true, value: { ...CARD, kind: 'pull-request' } })
    await lookupCard({ repositoryId: 'repo-1', owner: null, repo: null, number: 5, inProject: true })
    expect(render('#5')).toContain('<span class="sr-only">Pull request </span>')
  })
})

describe('ItemCardBody', () => {
  const body = (card: ItemCard) => renderToStaticMarkup(createElement(ItemCardBody, { card }))

  it('shows the Issue or Pull request type word in the card header', () => {
    expect(body(CARD)).toContain('Issue')
    expect(body({ ...CARD, kind: 'pull-request' })).toContain('Pull request')
  })
})
