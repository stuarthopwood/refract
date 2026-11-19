// The repo has no jsdom, so the button renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RailIconButton } from './RailIconButton'

function render(props: Parameters<typeof RailIconButton>[0]): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(RailIconButton, props)))
}

describe('RailIconButton', () => {
  it('names the button from label and renders as a plain 40 px button', () => {
    const html = render({ label: 'Right pane', children: 'x' })
    expect(html).toContain('aria-label="Right pane"')
    expect(html).toContain('type="button"')
    expect(html).toContain('size-10')
  })

  it('forwards state attributes so a toggle can carry aria-expanded and a panel button aria-pressed', () => {
    const forwarded = { label: 'Chat pane', 'aria-expanded': true, 'aria-pressed': false, 'data-rail-button': 'outline', children: 'x' }
    const html = render(forwarded)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('data-rail-button="outline"')
  })

  it('merges a caller class after the shared pressed look instead of replacing it', () => {
    const html = render({ label: 'Outline panel', className: 'relative', children: 'x' })
    expect(html).toMatch(/class="[^"]*aria-pressed:text-accent-text[^"]*relative[^"]*"/)
  })
})
