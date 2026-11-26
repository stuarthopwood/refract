// The repo has no jsdom, so the strip is rendered to a static string. Each test names the mutation that fails it.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GoalStrip } from './GoalStrip'

// CollapsedLine (for the icon slot class) imports the renderer state barrel, which needs a browser `window`.
vi.mock('@/state', () => ({ useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} }) }))

const render = (goal: string | undefined, className?: string) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(GoalStrip, { goal, className })))

describe('GoalStrip', () => {
  it('renders nothing without a goal and never invents one', () => {
    // Mutation: drop the early return, or fall back to a placeholder such as "No goal".
    expect(render(undefined)).toBe('')
    expect(render('')).toBe('')
  })

  it('shows the "Goal:" word and the goal text', () => {
    // Mutation: drop the word (the glyph alone is aria-hidden) or render a different field.
    const html = render('Ship the card')
    expect(html).toContain('Goal:')
    expect(html).toContain('Ship the card')
  })

  it('clamps to two lines while keeping the whole text in the DOM', () => {
    // Mutation: switch to `line-clamp-1`, or truncate the string in JS (a screen reader would lose the tail).
    const goal = 'x'.repeat(400)
    const html = render(goal)
    expect(html).toContain('line-clamp-2')
    expect(html).toContain(goal)
  })

  it('hides the decorative glyph from assistive tech', () => {
    // Mutation: drop aria-hidden on the glyph slot.
    expect(render('Goal')).toContain('aria-hidden="true"')
  })

  it('uses surface and divider tokens, never the mock palette', () => {
    // Mutation: copy zinc-* or hex colours from the design mock.
    const html = render('Goal')
    expect(html).toContain('bg-surface-1')
    expect(html).toContain('border-divider')
    expect(html).not.toMatch(/zinc-|emerald-|#0d0d10/)
  })

  it('lets the caller add classes without losing the strip treatment', () => {
    // Mutation: ignore `className`.
    const html = render('Goal', 'rounded-b-lg')
    expect(html).toContain('rounded-b-lg')
    expect(html).toContain('bg-surface-1')
  })
})
