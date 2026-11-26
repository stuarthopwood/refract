// The repo has no jsdom: the pure resolver carries the latch semantics, and a probe component rendered to a string
// covers the hook's wiring to the toggle store.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// A server render reads zustand's INITIAL state, never later `setState`, so the store is a plain selector over mutable state here.
const toggles = vi.hoisted(() => ({ bySession: {} as Record<string, Record<string, boolean>> }))
vi.mock('@/state', () => ({
  useStageToggleStore: (select: (state: object) => unknown) => select({ bySession: toggles.bySession, setManualOpen: () => undefined })
}))
import { resolveDisclosureOpen, useStickyDisclosure, type StickyDisclosureOptions } from './useStickyDisclosure'

const setManualOpen = (sessionId: string, rowId: string, open: boolean) => {
  toggles.bySession = { ...toggles.bySession, [sessionId]: { ...toggles.bySession[sessionId], [rowId]: open } }
}

function Probe({ sessionId, rowId, auto, options }: { sessionId: string | null; rowId: string | null; auto: boolean; options?: StickyDisclosureOptions }) {
  const { open } = useStickyDisclosure(sessionId, rowId, auto, options)
  return createElement('span', null, String(open))
}

function renderOpen(auto: boolean, options?: StickyDisclosureOptions, rowId: string | null = 'row'): string {
  return renderToStaticMarkup(createElement(Probe, { sessionId: 's1', rowId, auto, options }))
}

describe('resolveDisclosureOpen', () => {
  describe('given the default latching mode', () => {
    it('stays open after autoOpen turns false once it has been seen', () => {
      expect(resolveDisclosureOpen({ manual: undefined, latched: true, auto: false, latch: true })).toBe(true)
    })

    it('opens on the current autoOpen even before the latch has caught up', () => {
      expect(resolveDisclosureOpen({ manual: undefined, latched: false, auto: true, latch: true })).toBe(true)
    })

    it('stays closed when it was never auto-opened', () => {
      expect(resolveDisclosureOpen({ manual: undefined, latched: false, auto: false, latch: true })).toBe(false)
    })
  })

  describe('given the non-latching mode', () => {
    it('closes when autoOpen turns false, ignoring a stale latch', () => {
      expect(resolveDisclosureOpen({ manual: undefined, latched: true, auto: false, latch: false })).toBe(false)
    })

    it('opens while autoOpen is true', () => {
      expect(resolveDisclosureOpen({ manual: undefined, latched: false, auto: true, latch: false })).toBe(true)
    })
  })

  describe.each([true, false])('given a manual toggle in latch=%s mode', (latch) => {
    it('wins over autoOpen in both directions', () => {
      expect(resolveDisclosureOpen({ manual: false, latched: true, auto: true, latch })).toBe(false)
      expect(resolveDisclosureOpen({ manual: true, latched: false, auto: false, latch })).toBe(true)
    })
  })
})

describe('useStickyDisclosure', () => {
  beforeEach(() => {
    toggles.bySession = {}
  })

  it('keeps the default latching behaviour for callers that pass no options', () => {
    expect(renderOpen(true)).toContain('true')
    expect(renderOpen(false)).toContain('false')
  })

  it('follows autoOpen in non-latching mode', () => {
    expect(renderOpen(true, { latch: false })).toContain('true')
    expect(renderOpen(false, { latch: false })).toContain('false')
  })

  it('lets the stored manual toggle win in non-latching mode for the rest of the Session', () => {
    setManualOpen('s1', 'row', true)
    expect(renderOpen(false, { latch: false })).toContain('true')
    setManualOpen('s1', 'row', false)
    expect(renderOpen(true, { latch: false })).toContain('false')
  })

  it('keeps one row\'s manual toggle away from another row', () => {
    setManualOpen('s1', 'row', true)
    expect(renderOpen(false, { latch: false }, 'other')).toContain('false')
  })
})
