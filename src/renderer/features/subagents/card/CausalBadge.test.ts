import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CausalBadge, causalBadgeText } from './CausalBadge'

describe('CausalBadge (#1928)', () => {
  it('reads "fixes issue from <agent>"', () => {
    expect(causalBadgeText('GateA11y757m')).toBe('fixes issue from GateA11y757m')
    expect(renderToStaticMarkup(createElement(CausalBadge, { triggeredBy: 'GateA11y757m' }))).toContain('fixes issue from GateA11y757m')
  })

  it('names every agent the view-model joined', () => {
    expect(causalBadgeText('A, B')).toBe('fixes issue from A, B')
  })

  it('is absent when the trigger is unknown, empty or blank', () => {
    for (const value of [undefined, '', '  ']) {
      expect(causalBadgeText(value)).toBeNull()
      expect(renderToStaticMarkup(createElement(CausalBadge, { triggeredBy: value }))).toBe('')
    }
  })

  it('keeps one line, truncating a long name, with the full text in the title', () => {
    const html = renderToStaticMarkup(createElement(CausalBadge, { triggeredBy: 'X'.repeat(80) }))
    expect(html).toContain('truncate')
    expect(html).toContain(`title="fixes issue from ${'X'.repeat(80)}"`)
  })
})
