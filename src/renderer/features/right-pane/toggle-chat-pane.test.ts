// Spec 137 FR-013, FR-014, FR-018 to FR-020 (#2075): the chat hide/show rules are pure or store-only, so no DOM is needed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'
import { useViewStore } from '@/state/view-store'
import {
  canToggleChat,
  chatToggleFocus,
  effectiveChatCollapsed,
  hideChatPane,
  showChatPane,
  syncChatCollapsedFromDrag,
  toggleChatPane
} from './toggle-chat-pane'

const pane = () => useRightPaneStore.getState()
const frames: (() => void)[] = []
const elsewhere = { isConnected: true, closest: () => null, matches: () => false }

beforeEach(() => {
  frames.length = 0
  vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => undefined })
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('document', { activeElement: elsewhere, body: {}, querySelector: () => null, getElementById: () => null })
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
  useRightPaneStore.setState({ open: false, chatCollapsed: false })
  useSplitStore.setState({ paneSessionIds: ['s1'] })
  useViewStore.setState({ view: 'chat' })
  useAgentAnnouncementStore.setState({ message: '', serial: 0 })
})

afterEach(() => vi.unstubAllGlobals())

describe('effectiveChatCollapsed', () => {
  it('applies the stored preference only in the chat view', () => {
    expect(effectiveChatCollapsed(true, 'chat')).toBe(true)
    expect(effectiveChatCollapsed(true, 'home')).toBe(false)
    expect(effectiveChatCollapsed(false, 'chat')).toBe(false)
  })
})

describe('canToggleChat', () => {
  it('refuses to hide with no Session or outside the chat view', () => {
    expect(canToggleChat({ view: 'chat', hasSession: false, chatCollapsed: false })).toBe(false)
    expect(canToggleChat({ view: 'issues', hasSession: true, chatCollapsed: false })).toBe(false)
    expect(canToggleChat({ view: 'chat', hasSession: true, chatCollapsed: false })).toBe(true)
  })

  it('always allows showing a hidden chat', () => {
    expect(canToggleChat({ view: 'home', hasSession: false, chatCollapsed: true })).toBe(true)
  })
})

describe('chatToggleFocus', () => {
  const base = { hiding: true, viaKeyboard: false, focusInChat: false, focusLost: false }

  it('leaves focus alone after a pointer toggle that did not disturb it', () => {
    expect(chatToggleFocus(base)).toBe('none')
    expect(chatToggleFocus({ ...base, hiding: false })).toBe('none')
  })

  it('moves focus out of the area being hidden', () => {
    expect(chatToggleFocus({ ...base, focusInChat: true })).toBe('right-pane')
  })

  it('moves focus to the composer on show when the keyboard or a lost focus asks', () => {
    expect(chatToggleFocus({ ...base, hiding: false, viaKeyboard: true })).toBe('composer')
    expect(chatToggleFocus({ ...base, hiding: false, focusLost: true })).toBe('composer')
  })

  it('moves focus on a keyboard hide even when focus was elsewhere', () => {
    expect(chatToggleFocus({ ...base, viaKeyboard: true })).toBe('right-pane')
  })
})

describe('hideChatPane and showChatPane', () => {
  it('hiding opens the pane, collapses the chat and announces', () => {
    hideChatPane()
    expect(pane().chatCollapsed).toBe(true)
    expect(pane().open).toBe(true)
    expect(useAgentAnnouncementStore.getState().message).toBe('Chat hidden')
  })

  it('showing restores the chat and announces', () => {
    hideChatPane()
    showChatPane()
    expect(pane().chatCollapsed).toBe(false)
    expect(useAgentAnnouncementStore.getState().message).toBe('Chat shown')
  })

  it('does nothing when there is no Session to hide', () => {
    useSplitStore.setState({ paneSessionIds: [] })
    hideChatPane()
    expect(pane().chatCollapsed).toBe(false)
    expect(useAgentAnnouncementStore.getState().serial).toBe(0)
  })

  it('does nothing outside the chat view', () => {
    useViewStore.setState({ view: 'home' })
    hideChatPane()
    expect(pane().chatCollapsed).toBe(false)
  })

  it('showing still works when the view has left the chat', () => {
    pane().setChatCollapsed(true)
    useViewStore.setState({ view: 'home' })
    showChatPane()
    expect(pane().chatCollapsed).toBe(false)
  })

  it('moves focus on the next frame only for a keyboard toggle', () => {
    hideChatPane()
    expect(frames).toHaveLength(0)
    showChatPane({ viaKeyboard: true })
    expect(frames).toHaveLength(1)
  })
})

describe('toggleChatPane', () => {
  it('flips between hidden and shown', () => {
    toggleChatPane()
    expect(pane().chatCollapsed).toBe(true)
    toggleChatPane()
    expect(pane().chatCollapsed).toBe(false)
  })
})

describe('showing chat in a narrow window (FR-014)', () => {
  const shellFocus = { isConnected: true, closest: (selector: string) => (selector === '[data-right-pane-shell]' ? {} : null), matches: () => false }

  // The width model reads these two panels by id; chat needs 360 px, so the pane keeps 240 px only from a 880 px group beside a 280 px list.
  function stubLayout(groupWidthPx: number, activeElement: object = elsewhere) {
    const group = { clientWidth: groupWidthPx }
    const byId: Record<string, object> = { 'right-pane': { closest: () => group }, 'session-list': { offsetWidth: 280 } }
    vi.stubGlobal('document', { activeElement, body: {}, querySelector: () => null, getElementById: (id: string) => byId[id] ?? null })
  }

  beforeEach(() => useRightPaneStore.setState({ open: true, chatCollapsed: true, widthPx: 640 }))

  it('closes the pane, keeping its width, when 240 px does not remain', () => {
    stubLayout(879)
    showChatPane()
    expect(pane().chatCollapsed).toBe(false)
    expect(pane().open).toBe(false)
    expect(pane().widthPx).toBe(640)
  })

  it('closes the pane from the shared toggle too, so the rail and the shortcut match the menus', () => {
    stubLayout(879)
    toggleChatPane()
    expect(pane().chatCollapsed).toBe(false)
    expect(pane().open).toBe(false)
  })

  it('keeps the pane open when 240 px remains', () => {
    stubLayout(880)
    showChatPane()
    expect(pane().chatCollapsed).toBe(false)
    expect(pane().open).toBe(true)
  })

  it('keeps the pane open when the layout cannot be measured', () => {
    showChatPane()
    expect(pane().open).toBe(true)
  })

  it('moves focus to the composer when the closing pane held it', () => {
    stubLayout(879, shellFocus)
    showChatPane()
    expect(frames).toHaveLength(1)
  })

  it('leaves focus alone when the pane stays open', () => {
    stubLayout(880, shellFocus)
    showChatPane()
    expect(frames).toHaveLength(0)
  })
})

describe('syncChatCollapsedFromDrag', () => {
  it('syncs the store and announces without moving focus', () => {
    syncChatCollapsedFromDrag(true)
    expect(pane().chatCollapsed).toBe(true)
    expect(pane().open).toBe(true)
    expect(useAgentAnnouncementStore.getState().message).toBe('Chat hidden')
    syncChatCollapsedFromDrag(false)
    expect(pane().chatCollapsed).toBe(false)
    expect(useAgentAnnouncementStore.getState().message).toBe('Chat shown')
    expect(frames).toHaveLength(0)
  })

  it('stays silent when the state already matches', () => {
    syncChatCollapsedFromDrag(false)
    expect(useAgentAnnouncementStore.getState().serial).toBe(0)
  })
})
