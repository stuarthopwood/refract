// Spec 137 FR-016, FR-020 (#2075 T019): the chat toggle chord and the not-collapsed guards, driven through
// `useChordDispatcher` with real built-in actions. `useEffect` runs inline because the suites have no DOM.
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'
import { useViewStore } from '@/state/view-store'

const mocks = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  closeChatPane: vi.fn(),
  newSession: vi.fn()
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect()
    if (cleanup) mocks.cleanups.push(cleanup)
  }
}))
// The real `@/state` barrel wires every store to `window` at import time; these tests need only three.
// Dynamic imports: vi.mock factories are hoisted above the static imports, so they cannot use them.
vi.mock('@/state', async () => ({
  useViewStore: (await import('@/state/view-store')).useViewStore,
  useSplitStore: (await import('@/state/split-store')).useSplitStore,
  useRightPaneStore: (await import('@/state/right-pane-store')).useRightPaneStore,
  useSessionsStore: { getState: () => ({ sessions: [] }) },
  useThemeStore: { getState: () => ({ resetToDark: vi.fn() }) }
}))
vi.mock('@/features/chat/pauseActions', () => ({ canTogglePause: () => false, setAllPaused: vi.fn(), setSessionPaused: vi.fn() }))
vi.mock('@/features/chat/closeChatPane', () => ({ closeChatPane: mocks.closeChatPane }))
vi.mock('@/features/chat/restoreQueue', () => ({ stopAndRestore: vi.fn() }))
vi.mock('@/features/right-pane/toggle-right-pane', () => ({ toggleRightPane: vi.fn() }))
vi.mock('@/features/sessions/newSessionInFocusedPane', () => ({
  focusedPaneRepository: () => undefined,
  focusedPaneSessionId: () => null,
  newSessionInFocusedPane: mocks.newSession
}))
vi.mock('@/features/sessions/ItemSessionDialogHost', () => ({ useItemSessionDialogStore: { getState: () => ({ open: vi.fn() }) } }))
vi.mock('@/lib/focus', () => ({ focusSessionPane: vi.fn(), isFocusStranded: () => false }))
vi.mock('./paletteStore', () => ({ usePaletteStore: { getState: () => ({ setOpen: vi.fn() }) } }))

import { registerBuiltinActions } from './builtinActions'
import { installKeyboardHost, type KeyboardHost } from './chordTestHarness'
import { useChordDispatcher } from './useChordDispatcher'
import { findAction, isActionEnabled } from './actionRegistry'

const CTRL_SHIFT_H = { key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true }
const CTRL_W = { key: 'w', code: 'KeyW', ctrlKey: true }
const CTRL_SHIFT_BACKSLASH = { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true }
const CTRL_N = { key: 'n', code: 'KeyN', ctrlKey: true }

const pane = () => useRightPaneStore.getState()
const announced = () => useAgentAnnouncementStore.getState().message
let host: KeyboardHost
let unregister: () => void
let focusOther: Mock

beforeEach(() => {
  host = installKeyboardHost()
  unregister = registerBuiltinActions()
  focusOther = vi.fn()
  mocks.closeChatPane.mockClear()
  mocks.newSession.mockClear()
  useRightPaneStore.setState({ open: false, chatCollapsed: false })
  useSplitStore.setState({ paneSessionIds: ['s1'], focusedIndex: 0, focusOther })
  useViewStore.setState({ view: 'chat' })
  useAgentAnnouncementStore.setState({ message: '', serial: 0 })
  useChordDispatcher(true)
})

afterEach(() => {
  for (const cleanup of mocks.cleanups.splice(0)) cleanup()
  unregister()
  vi.unstubAllGlobals()
})

describe('Ctrl+Shift+H', () => {
  it('hides and shows the chat, swallowing the key and announcing each change', () => {
    expect(host.press(CTRL_SHIFT_H)).toBe(true)
    expect(pane().chatCollapsed).toBe(true)
    expect(announced()).toBe('Chat hidden')
    expect(host.press(CTRL_SHIFT_H)).toBe(true)
    expect(pane().chatCollapsed).toBe(false)
    expect(announced()).toBe('Chat shown')
  })

  it('moves focus even when it was not inside the chat, because the shortcut was used', () => {
    host.press(CTRL_SHIFT_H)
    expect(host.frames).toHaveLength(1)
  })

  it('matches a lower-case key as well, as with Caps Lock', () => {
    host.press({ ...CTRL_SHIFT_H, key: 'h' })
    expect(pane().chatCollapsed).toBe(true)
  })

  it('does nothing outside the chat view', () => {
    useViewStore.setState({ view: 'home' })
    expect(host.press(CTRL_SHIFT_H)).toBe(false)
    expect(pane().chatCollapsed).toBe(false)
  })

  it('ignores auto-repeat', () => {
    expect(host.press({ ...CTRL_SHIFT_H, repeat: true })).toBe(false)
    expect(pane().chatCollapsed).toBe(false)
  })

  it('ignores a key press that is part of IME composition', () => {
    expect(host.press({ ...CTRL_SHIFT_H, isComposing: true })).toBe(false)
    expect(pane().chatCollapsed).toBe(false)
  })

  it('ignores the key while a dialog, menu or select is open', () => {
    host.setOverlayOpen(true)
    expect(host.press(CTRL_SHIFT_H)).toBe(false)
    expect(pane().chatCollapsed).toBe(false)
  })

  it.each([
    ['Ctrl+Alt+H', { ctrlKey: true, altKey: true }],
    ['Ctrl+Shift+Alt+H', { ctrlKey: true, shiftKey: true, altKey: true }],
    ['Alt+Shift+H', { shiftKey: true, altKey: true }],
    ['Alt+H', { altKey: true }]
  ])('does not match %s', (_name, modifiers) => {
    expect(host.press({ key: 'H', code: 'KeyH', ...modifiers })).toBe(false)
    expect(pane().chatCollapsed).toBe(false)
  })

  it.each([
    ['Ctrl+H', { ctrlKey: true }],
    ['Shift+H', { shiftKey: true }],
    ['H', {}],
    ['Ctrl+Shift+Meta+H', { ctrlKey: true, shiftKey: true, metaKey: true }],
    ['Meta+Shift+H', { metaKey: true, shiftKey: true }]
  ])('does not match %s: the chord is exactly Ctrl+Shift+H', (_name, modifiers) => {
    expect(host.press({ key: 'H', code: 'KeyH', ...modifiers })).toBe(false)
    expect(pane().chatCollapsed).toBe(false)
  })

  it('does not match another key with the same modifiers', () => {
    expect(host.press({ key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(pane().chatCollapsed).toBe(false)
  })
})

describe('chords that must stay off while chat is hidden (FR-020)', () => {
  beforeEach(() => useSplitStore.setState({ paneSessionIds: ['s1', 's2'], focusedIndex: 1, focusOther }))

  it('Ctrl+W closes the focused chat pane while chat is shown', () => {
    expect(host.press(CTRL_W)).toBe(true)
    expect(mocks.closeChatPane).toHaveBeenCalledWith(1)
  })

  it('Ctrl+W is not swallowed or run while chat is hidden', () => {
    host.press(CTRL_SHIFT_H)
    expect(host.press(CTRL_W)).toBe(false)
    expect(mocks.closeChatPane).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+\\ moves focus to the other pane while chat is shown', () => {
    expect(host.press(CTRL_SHIFT_BACKSLASH)).toBe(true)
    expect(focusOther).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Shift+\\ is not swallowed or run while chat is hidden', () => {
    host.press(CTRL_SHIFT_H)
    expect(host.press(CTRL_SHIFT_BACKSLASH)).toBe(false)
    expect(focusOther).not.toHaveBeenCalled()
  })

  it('both work again once chat is shown', () => {
    host.press(CTRL_SHIFT_H)
    host.press(CTRL_SHIFT_H)
    expect(host.press(CTRL_W)).toBe(true)
    expect(host.press(CTRL_SHIFT_BACKSLASH)).toBe(true)
  })

  it('a stored hidden preference does not block them outside the chat view', () => {
    pane().setChatCollapsed(true)
    useViewStore.setState({ view: 'home' })
    expect(host.press(CTRL_SHIFT_BACKSLASH)).toBe(true)
    expect(focusOther).toHaveBeenCalledTimes(1)
  })
})

describe('Ctrl+N while chat is hidden', () => {
  it('still runs, so the quick-create fallback announcement can fire (FR-020)', () => {
    host.press(CTRL_SHIFT_H)
    expect(host.press(CTRL_N)).toBe(true)
    expect(mocks.newSession).toHaveBeenCalledTimes(1)
  })
})

describe('the "Hide or show chat" palette entry (FR-020)', () => {
  const enabled = () => {
    const action = findAction('toggle-chat-pane')
    return action !== undefined && isActionEnabled(action)
  }

  it('is offered with a Session open in the chat view', () => {
    expect(enabled()).toBe(true)
  })

  it('is not offered, and the chord stays off, with no Session to hide', () => {
    useSplitStore.setState({ paneSessionIds: [] })
    expect(enabled()).toBe(false)
    expect(host.press(CTRL_SHIFT_H)).toBe(false)
  })

  it('is offered while chat is hidden, so Show can never be stuck', () => {
    pane().setChatCollapsed(true)
    useSplitStore.setState({ paneSessionIds: [] })
    expect(enabled()).toBe(true)
  })
})

describe('listener lifecycle', () => {
  it('registers one keydown listener per mounted dispatcher and removes it on cleanup', () => {
    expect(host.listenerCount()).toBe(1)
    for (const cleanup of mocks.cleanups.splice(0)) cleanup()
    expect(host.listenerCount()).toBe(0)
  })
})
