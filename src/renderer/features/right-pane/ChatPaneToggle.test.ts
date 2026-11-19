// The repo has no jsdom, so the presentational button renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The rail pulls `sessionDisplay.tsx`, whose store barrel dev hook needs `window`.
vi.mock('@/state', () => ({ useSettingsStore: () => undefined }))
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChatPaneToggleButton } from './ChatPaneToggle'

function render(props: Partial<Parameters<typeof ChatPaneToggleButton>[0]> = {}): string {
  const full = { hidden: false, needsYou: 0, disabled: false, onToggle: () => undefined, ...props }
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ChatPaneToggleButton, full)))
}

describe('ChatPaneToggleButton', () => {
  it('Given chat showing, Then it is named "Chat pane", expanded, and controls the chat panel without aria-pressed', () => {
    const html = render()
    expect(html).toContain('aria-label="Chat pane"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-controls="chat-panel"')
    expect(html).toContain('aria-keyshortcuts="Control+Shift+H"')
    expect(html).not.toContain(' aria-pressed=')
  })

  it('Given chat hidden, Then aria-expanded is false and the name does not change', () => {
    const html = render({ hidden: true })
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Chat pane"')
  })

  it('Given chat hidden and one Session needs the developer, Then the name carries the count and the badge shows it', () => {
    const html = render({ hidden: true, needsYou: 1 })
    expect(html).toContain('aria-label="Chat pane, 1 needs you"')
    expect(html).toMatch(/aria-hidden="true"[^>]*>1</)
  })

  it('Given chat showing and a waiting Session, Then there is no badge and the name stays plain', () => {
    const html = render({ hidden: false, needsYou: 2 })
    expect(html).toContain('aria-label="Chat pane"')
    expect(html).not.toContain('tabular-nums')
  })

  it('Given no Session, Then the button is disabled', () => {
    expect(render({ disabled: true })).toContain('disabled=""')
  })
})
