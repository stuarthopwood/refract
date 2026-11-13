// Issue #1950: the type icon is neutral until a lookup resolved the type, then follows kind and state.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ItemCard } from '../../../shared/ipc-item-refs'

// The PR state map is imported from a module that reaches the stores, which assume a browser `window`.
vi.mock('@/state', () => ({}))

import { ItemTypeIcon, itemDisplayState, itemTypeVisual } from './ItemTypeIcon'

const CARD: ItemCard = {
  ownerRepo: 'me/app',
  number: 1,
  kind: 'issue',
  title: 'T',
  state: 'open',
  draft: false,
  url: 'https://github.com/me/app/issues/1',
  createdAt: '2026-11-01T00:00:00Z',
  authorLogin: 'me',
  avatarDataUrl: null,
  baseRef: null,
  headRef: null
}

describe('itemTypeVisual', () => {
  it('is neutral and unlabelled before a lookup', () => {
    expect(itemTypeVisual(undefined).label).toBeNull()
    expect(itemTypeVisual(null).label).toBeNull()
    expect(itemTypeVisual(undefined).colorClass).toBe('text-muted-foreground')
  })

  it('labels an issue and colours it by state', () => {
    expect(itemTypeVisual(CARD)).toMatchObject({ label: 'Issue', colorClass: 'text-pr-open' })
    expect(itemTypeVisual({ ...CARD, state: 'closed' }).colorClass).toBe('text-pr-merged')
  })

  it('labels a pull request and colours it by state, draft included', () => {
    const pr = { ...CARD, kind: 'pull-request' as const }
    expect(itemTypeVisual(pr)).toMatchObject({ label: 'Pull request', colorClass: 'text-pr-open' })
    expect(itemTypeVisual({ ...pr, draft: true }).colorClass).toBe('text-pr-draft')
    expect(itemTypeVisual({ ...pr, state: 'merged' }).colorClass).toBe('text-pr-merged')
  })
})

describe('itemDisplayState', () => {
  it('is draft only for an open draft, else the card state', () => {
    expect(itemDisplayState({ ...CARD, draft: true })).toBe('draft')
    expect(itemDisplayState({ ...CARD, draft: true, state: 'merged' })).toBe('merged')
    expect(itemDisplayState(CARD)).toBe('open')
  })
})

describe('ItemTypeIcon', () => {
  it('marks the rendered icon with its type and hides it from assistive tech', () => {
    const neutral = renderToStaticMarkup(createElement(ItemTypeIcon, { card: undefined }))
    const issue = renderToStaticMarkup(createElement(ItemTypeIcon, { card: CARD }))
    expect(neutral).toContain('data-item-type="unknown"')
    expect(issue).toContain('data-item-type="issue"')
    expect(issue).toContain('aria-hidden="true"')
  })
})
