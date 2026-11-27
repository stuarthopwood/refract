import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ParallelBadge, parallelBadgeName, parallelBadgeText } from './ParallelBadge'

const render = (count: number) => renderToStaticMarkup(createElement(ParallelBadge, { count }))

describe('ParallelBadge', () => {
  it('words the visible text and the accessible name', () => {
    expect(parallelBadgeText(3)).toBe('3')
    expect(parallelBadgeName(3)).toBe('3 agents in parallel')
  })

  it('renders a borderless fork glyph, the bare count and a screen-reader name for several agents', () => {
    const html = render(3)
    expect(html).toContain('data-parallel-badge')
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/)
    expect(html).toContain('<span aria-hidden="true">3</span>')
    expect(html).toContain('<span class="sr-only">3 agents in parallel</span>')
    expect(html).not.toMatch(/\bborder\b/)
    expect(html).toContain('bg-surface-1')
  })

  it.each([0, 1])('renders nothing for %i agent(s)', (count) => {
    expect(render(count)).toBe('')
  })
})
