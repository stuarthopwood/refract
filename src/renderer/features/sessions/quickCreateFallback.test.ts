// Spec 137 FR-020 (#2075 T019): Ctrl+N's fallback tells the user how to pick a project through the chat-area
// announcer, which App.tsx mounts outside the collapsible chat panel, so hidden chat must not change it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useRightPaneStore } from '@/state/right-pane-store'
import { announceQuickCreateFallback } from './quickCreateFallback'

interface Focusable {
  focus(): void
}

/** Every filter selector resolves to the search field when present, else the funnel; the quick-create selector to its button. */
function stubDocument(elements: { quickCreate?: object; search?: boolean; funnel?: boolean }): void {
  let active: unknown = null
  const focusTarget = (): Focusable => {
    const target: Focusable = { focus: () => void (active = target) }
    return target
  }
  const search = elements.search ? focusTarget() : null
  const funnel = elements.funnel ? focusTarget() : null
  vi.stubGlobal('document', {
    get activeElement() {
      return active
    },
    querySelector: (selector: string) => (selector === '[data-quick-create-session]' ? (elements.quickCreate ?? null) : (search ?? funnel))
  })
}

function announcement(): string {
  vi.advanceTimersByTime(0) // runs the announcer's deferred set but not its 6 s auto-clear
  return useChatAreaAnnouncer.getState().text
}

beforeEach(() => {
  vi.useFakeTimers()
  useChatAreaAnnouncer.setState({ text: '' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each([false, true])('announceQuickCreateFallback with chat hidden = %s', (hidden) => {
  beforeEach(() => useRightPaneStore.setState({ open: true, chatCollapsed: hidden }))

  it('points at the session list when no filter field can take focus', () => {
    stubDocument({})
    announceQuickCreateFallback()
    expect(announcement()).toBe('Open the session list to choose a project for the new session')
  })

  it('points at the session list when a quick-create button exists', () => {
    stubDocument({ quickCreate: {}, search: true })
    announceQuickCreateFallback()
    expect(announcement()).toBe('Open the session list to choose a project for the new session')
  })

  it('asks to clear the filter when focus lands on the search field', () => {
    stubDocument({ search: true })
    announceQuickCreateFallback()
    expect(announcement()).toBe('Clear the filter to choose a project for the new session')
  })
})
