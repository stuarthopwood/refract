import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ParallelBadge, parallelBadgeName, parallelBadgeText } from './ParallelBadge'

const render = (count: number) => renderToStaticMarkup(createElement(ParallelBadge, { count }))

describe('ParallelBadge', () => {
  it('words the visible text and the accessible name', () => {
    expect(parallelBadgeText(3)).toBe('3 parallel')
    expect(parallelBadgeName(3)).toBe('3 agents in parallel')
  })

  it('renders the fork glyph, the short text and a screen-reader name for several agents', () => {
    const html = render(3)
    expect(html).toContain('data-parallel-badge')
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(html).toContain('<span aria-hidden="true">3 parallel</span>')
    expect(html).toContain('<span class="sr-only">3 agents in parallel</span>')
  })

  it.each([0, 1])('renders nothing for %i agent(s)', (count) => {
    expect(render(count)).toBe('')
  })
})
