// Issue #1778: the palette's Open Usage uses the same gauge icon as the left and right rails.
import { GaugeIcon } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The real `@/state` barrel wires every store to `window` at import time; registration needs none of it.
vi.mock('@/state', () => ({
  useViewStore: { getState: () => ({ view: 'chat', openUsage: vi.fn() }) },
  useSplitStore: { getState: () => ({ paneSessionIds: [] }) },
  useRightPaneStore: { getState: () => ({ chatCollapsed: false }) },
  useSessionsStore: { getState: () => ({ sessions: [] }) },
  useThemeStore: { getState: () => ({ resetToDark: vi.fn() }) }
}))
vi.mock('@/features/chat/pauseActions', () => ({ canTogglePause: () => false, setAllPaused: vi.fn(), setSessionPaused: vi.fn() }))
vi.mock('@/features/chat/closeChatPane', () => ({ closeChatPane: vi.fn() }))
vi.mock('@/features/chat/restoreQueue', () => ({ stopAndRestore: vi.fn() }))
vi.mock('@/features/right-pane/toggle-chat-pane', () => ({ canToggleChat: () => false, effectiveChatCollapsed: () => false, toggleChatPane: vi.fn() }))
vi.mock('@/features/right-pane/toggle-right-pane', () => ({ toggleRightPane: vi.fn() }))
vi.mock('@/features/sessions/newSessionInFocusedPane', () => ({
  focusedPaneRepository: () => undefined,
  focusedPaneSessionId: () => null,
  newSessionInFocusedPane: vi.fn()
}))
vi.mock('@/features/sessions/ItemSessionDialogHost', () => ({ useItemSessionDialogStore: { getState: () => ({ open: vi.fn() }) } }))
vi.mock('@/lib/focus', () => ({ focusSessionPane: vi.fn(), isFocusStranded: () => false }))
vi.mock('./paletteStore', () => ({ usePaletteStore: { getState: () => ({ setOpen: vi.fn() }) } }))

import { findAction } from './actionRegistry'
import { registerBuiltinActions } from './builtinActions'

describe('built-in palette actions', () => {
  let unregister: (() => void) | undefined
  afterEach(() => unregister?.())

  it('open_usage_uses_the_gauge_icon', () => {
    unregister = registerBuiltinActions()
    expect(findAction('open-usage')?.icon).toBe(GaugeIcon)
  })
})
