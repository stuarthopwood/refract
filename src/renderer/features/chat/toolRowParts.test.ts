// The repo has no jsdom: the slot is rendered to a static string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
// CollapsedLine (imported by toolRowParts) pulls in the renderer state barrel, which needs a browser `window`.
vi.mock('@/state', () => ({ useSettingsStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }))
import { RowTrailing, toolRowMeta } from './toolRowParts'

const render = (node: React.ReactNode): string => renderToStaticMarkup(createElement('div', null, node))

describe('RowTrailing (#2189)', () => {
  describe('given rows with and without a duration', () => {
    it('keeps the duration column in the markup so the icon stays in one x', () => {
      const withDuration = render(toolRowMeta('done', undefined, '39.8s'))
      const withoutDuration = render(toolRowMeta('running', undefined, undefined))
      expect(withDuration).toContain('data-slot="row-duration"')
      expect(withoutDuration).toContain('data-slot="row-duration"')
      expect(withDuration).toContain('39.8s')
      expect(withoutDuration).not.toContain('sr-only">, </span>')
    })
  })

  describe('given lead text', () => {
    it('places the lead before the icon and the duration column last', () => {
      const html = render(createElement(RowTrailing, { icon: createElement('i', { id: 'icon' }), lead: createElement('b', { id: 'lead' }), duration: '1s' }))
      expect(html.indexOf('id="lead"')).toBeLessThan(html.indexOf('id="icon"'))
      expect(html.indexOf('id="icon"')).toBeLessThan(html.indexOf('data-slot="row-duration"'))
    })
  })
})
