// The repo has no jsdom, so the presentational button renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The rail pulls `sessionDisplay.tsx`, whose store barrel dev hook needs `window`.
vi.mock('@/state', () => ({ useSettingsStore: () => undefined }))
import { TooltipProvider } from '@/components/ui/tooltip'
import { ChatPaneToggleButton, chatToggleDisabledReason } from './ChatPaneToggle'

function render(props: Partial<Parameters<typeof ChatPaneToggleButton>[0]> = {}): string {
  const full = { hidden: false, needsYou: 0, disabledReason: null, onToggle: () => undefined, ...props }
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

  it('Given chat hidden, Then aria-expanded is false, the name does not change and the glyph swaps to the off icon', () => {
    const html = render({ hidden: true })
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Chat pane"')
    expect(html).toContain('lucide-message-square-off')
    expect(render({ hidden: false })).not.toContain('lucide-message-square-off')
  })

  it('Given chat hidden and one Session needs the developer, Then the name carries the count and the badge shows it', () => {
    const html = render({ hidden: true, needsYou: 1 })
    expect(html).toContain('aria-label="Chat pane, 1 needs you"')
    expect(html).toMatch(/aria-hidden="true"[^>]*>1</)
  })

  it('Given chat showing and a waiting Session, Then there is no badge and the name stays plain', () => {
    const html = render({ hidden: false, needsYou: 2 })
    expect(html).toContain('aria-label="Chat pane"')
    expect(html).not.toContain('>2<')
  })

  it('Given the toggle is inert, Then it is aria-disabled with the dimming variant and not natively disabled, so the tooltip can show', () => {
    const html = render({ disabledReason: 'Open a Session to show chat' })
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('aria-disabled:opacity-50')
    expect(html).not.toContain(' disabled=""')
  })

  it('Given the toggle works, Then it carries no aria-disabled', () => {
    expect(render()).not.toContain('aria-disabled="')
  })
})

describe('chatToggleDisabledReason', () => {
  it('Given a chat view with a Session, Then there is no reason', () => {
    expect(chatToggleDisabledReason({ canToggle: true, hasSession: true })).toBeNull()
  })

  it('Given no Session, Then the reason tells the user to open one', () => {
    expect(chatToggleDisabledReason({ canToggle: false, hasSession: false })).toBe('Open a Session to show chat')
  })

  it('Given a Session but another view, Then the reason points back to the chat view', () => {
    expect(chatToggleDisabledReason({ canToggle: false, hasSession: true })).toBe('Switch to the chat view to hide or show chat')
  })
})
