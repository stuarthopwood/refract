// The repo has no jsdom, so the chip is rendered to a static string. Each test names the mutation that fails it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LabelOverflow } from './LabelOverflow'
import { TooltipProvider } from '@/components/ui/tooltip'

const render = (labels: { name: string; color: string }[], className?: string) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(LabelOverflow, { labels, className })))

const hidden = [
  { name: 'docs', color: 'ff0000' },
  { name: 'p1', color: '00ff00' },
  { name: 'bug', color: '0000ff' }
]

describe('LabelOverflow', () => {
  it('renders nothing when no labels are hidden', () => {
    // Mutation: remove the empty-list early return (an empty "+0" chip would render).
    expect(render([])).toBe('')
  })

  it('is a real type=button, so Tab reaches it and Enter or Space need no custom handler', () => {
    // Mutation: render a span or drop `type="button"`.
    expect(render(hidden)).toMatch(/<button[^>]*type="button"[^>]*>\+3<\/button>/)
  })

  it('names the chip with the visible "+3" first and every hidden label after it', () => {
    // Mutation: revert the name to "+3 more labels" or drop the aria-label.
    expect(render(hidden)).toContain('aria-label="+3 more labels: docs, p1, bug"')
  })

  it('uses accent text and no border colour in any state (#1873)', () => {
    // Mutations: switch back to the outline variant (border-border, hover:border-ring) or to muted text.
    const html = render(hidden)
    expect(html).toContain('text-accent-text')
    expect(html).not.toContain('border-border')
    expect(html).not.toContain('border-ring')
    expect(html).not.toContain('text-muted-foreground')
  })

  it('shows keyboard focus with an outline rather than a border', () => {
    // Mutation: drop the focus-visible outline from the `plain` Badge variant, leaving only a faint glow.
    expect(render(hidden)).toContain('focus-visible:outline-ring')
    // Mutation: drop `focus-visible:ring-0`, so the base glow shows on top of the inset outline.
    expect(render(hidden)).toContain('focus-visible:ring-0')
  })

  it('lets the caller add layout classes without losing the chip treatment', () => {
    // Mutation: ignore `className` or let it replace the variant classes.
    const html = render(hidden, 'relative -my-1')
    expect(html).toContain('relative -my-1')
    expect(html).toContain('text-accent-text')
  })
})
