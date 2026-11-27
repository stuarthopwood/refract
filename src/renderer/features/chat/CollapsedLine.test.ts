// The repo has no jsdom: rows are rendered to a static string (no layout, so no measured overflow) and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/state', () => ({ useSettingsStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }))
import { CollapsedLine } from './CollapsedLine'
import { isRowExpandable, isTextClipped } from './useSummaryTruncation'

const render = (bodyAddsContent: boolean | undefined, props: { open?: boolean } = {}): string =>
  renderToStaticMarkup(createElement(CollapsedLine, { icon: null, label: 'Note', summary: 'one line', bodyAddsContent, ...props }, createElement('p', null, 'one line')))

describe('isTextClipped', () => {
  it('is true only when the content is wider than the box', () => {
    expect(isTextClipped({ scrollWidth: 300, clientWidth: 200 })).toBe(true)
    expect(isTextClipped({ scrollWidth: 200, clientWidth: 200 })).toBe(false)
  })
})

describe('isRowExpandable (#1875)', () => {
  it.each([
    [true, false, false, true],
    [false, true, false, true],
    [false, false, true, true],
    [false, false, false, false]
  ])('bodyAddsContent=%s clipped=%s open=%s -> %s', (bodyAddsContent, summaryClipped, open, expected) => {
    expect(isRowExpandable({ bodyAddsContent, summaryClipped, open })).toBe(expected)
  })
})

describe('CollapsedLine with a body that repeats its summary', () => {
  describe('given a summary that fits', () => {
    it('renders no expand control and no body', () => {
      const html = render(false)
      expect(html).not.toContain('<button')
      expect(html).not.toContain('aria-expanded')
      expect(html).not.toContain('<svg')
    })
  })
  describe('given a body that adds content (the default)', () => {
    it('renders the expand control', () => {
      expect(render(undefined)).toContain('aria-expanded')
      expect(render(true)).toContain('<button')
    })
  })
  describe('given the row is already open', () => {
    it('stays an expand control', () => {
      expect(render(false, { open: true })).toContain('aria-expanded="true"')
    })
  })
})
