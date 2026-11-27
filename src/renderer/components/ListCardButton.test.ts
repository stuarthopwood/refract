// The repo has no jsdom: the card is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ListCardButton, type ListCardButtonProps } from './ListCardButton'

const render = (props: Partial<ListCardButtonProps> = {}) =>
  renderToStaticMarkup(createElement(ListCardButton, { ariaLabel: 'Open it', onClick: () => undefined, children: createElement('span', null, 'body'), ...props }))

describe('ListCardButton', () => {
  it('is one button carrying the accessible name, with the actions beside it and not inside it', () => {
    const html = render({ actions: createElement('i', { 'data-action': '' }) })
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Open it"')
    expect(html.indexOf('</button>')).toBeLessThan(html.indexOf('data-action'))
  })

  it('points aria-describedby at the given description, and leaves it off otherwise', () => {
    expect(render({ ariaDescribedBy: 'out-1' })).toContain('aria-describedby="out-1"')
    expect(render()).not.toContain('aria-describedby')
  })

  it('the surface variant is a bordered bg-surface-1 card with a block, padded body and the hover tint', () => {
    const html = render({ variant: 'surface' })
    expect(html).toContain('border-divider')
    expect(html).toContain('bg-surface-1')
    expect(html).toContain('hover:bg-surface-hover')
    expect(html).toMatch(/<button[^>]*class="[^"]*\bblock\b[^"]*\bp-2\b/)
  })

  it('the flush variant keeps the hover tint but draws no fill, edge or padding', () => {
    const html = render({ variant: 'flush' })
    expect(html).toContain('border-transparent')
    expect(html).toContain('bg-transparent')
    expect(html).toContain('hover:bg-surface-hover')
    expect(html).not.toContain('bg-surface-1')
    expect(html).not.toMatch(/<button[^>]*class="[^"]*\bp-2\b/)
  })

  it('the default row variant stays a flex column button, not a block', () => {
    expect(render()).toMatch(/<button[^>]*class="[^"]*\bflex-col\b/)
  })
})
