import { ArrowLeftRightIcon, BarChart3Icon, CommandIcon, PanelRightIcon, PauseIcon, PlayIcon, PlusIcon, SettingsIcon, SquareIcon, XIcon } from 'lucide-react'
import { canTogglePause, setAllPaused, setSessionPaused } from '@/features/chat/pauseActions'
import { closeChatPane } from '@/features/chat/closeChatPane'
import { stopAndRestore } from '@/features/chat/restoreQueue'
import { toggleRightPane } from '@/features/right-pane/toggle-right-pane'
import { focusedPaneSessionId, newSessionInFocusedPane } from '@/features/sessions/newSessionInFocusedPane'
import { focusSessionPane } from '@/lib/focus'
import { useSessionsStore, useSplitStore, useViewStore } from '@/state'
import { registerActions, type PaletteAction } from './actionRegistry'
import { usePaletteStore } from './paletteStore'

function focusedSession() {
  const id = focusedPaneSessionId()
  return id ? useSessionsStore.getState().sessions.find((session) => session.id === id) : undefined
}

function liveSessions() {
  return useSessionsStore.getState().sessions.filter((session) => !session.archivedAt)
}

const BUILTIN_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'open-palette',
    icon: CommandIcon,
    label: 'Command palette',
    group: 'General',
    chord: ['Ctrl', 'K'],
    aliasChord: ['Ctrl', 'Shift', 'P'],
    when: () => true,
    run: () => usePaletteStore.getState().setOpen(true)
  },
  {
    id: 'stop',
    icon: SquareIcon,
    label: 'Stop',
    group: 'Message box',
    chord: ['Ctrl', 'Shift', 'X'],
    chordUnguarded: true,
    keywords: ['cancel', 'turn', 'interrupt'],
    when: () => focusedSession()?.status === 'working',
    run: () => {
      const id = focusedPaneSessionId()
      if (id) void stopAndRestore(id, () => focusSessionPane(id))
    }
  },
  {
    id: 'new-session',
    icon: PlusIcon,
    label: 'New session',
    group: 'Sessions',
    chord: ['Ctrl', 'N'],
    keywords: ['create', 'worktree'],
    when: () => useViewStore.getState().view === 'chat',
    run: newSessionInFocusedPane
  },
  {
    id: 'pause-session',
    icon: PauseIcon,
    label: 'Pause session',
    group: 'Pause',
    when: () => {
      const session = focusedSession()
      return session !== undefined && canTogglePause(session) && !session.pause
    },
    run: () => {
      const id = focusedPaneSessionId()
      if (id) void setSessionPaused(id, true)
    }
  },
  {
    id: 'resume-session',
    icon: PlayIcon,
    label: 'Resume session',
    group: 'Pause',
    when: () => !!focusedSession()?.pause,
    run: () => {
      const id = focusedPaneSessionId()
      if (id) void setSessionPaused(id, false)
    }
  },
  {
    id: 'pause-all',
    icon: PauseIcon,
    label: 'Pause all',
    group: 'Pause',
    when: () => liveSessions().some((session) => session.status !== 'stopped' && !session.pause),
    run: () => void setAllPaused(true)
  },
  {
    id: 'resume-all',
    icon: PlayIcon,
    label: 'Resume all',
    group: 'Pause',
    when: () => liveSessions().some((session) => !!session.pause),
    run: () => void setAllPaused(false)
  },
  {
    id: 'close-chat-pane',
    icon: XIcon,
    label: 'Close chat pane',
    group: 'Chat pane',
    chord: ['Ctrl', 'W'],
    when: () => useViewStore.getState().view === 'chat' && useSplitStore.getState().paneSessionIds.length > 0,
    run: () => {
      const { paneSessionIds, focusedIndex } = useSplitStore.getState()
      closeChatPane(paneSessionIds.length === 2 ? focusedIndex : 0)
    }
  },
  {
    id: 'toggle-right-pane',
    icon: PanelRightIcon,
    label: 'Collapse or expand the right pane',
    group: 'Right pane',
    chord: ['Ctrl', 'Shift', 'B'],
    keywords: ['toggle', 'hide', 'show'],
    when: () => useViewStore.getState().view === 'chat',
    run: toggleRightPane
  },
  {
    id: 'focus-other-pane',
    icon: ArrowLeftRightIcon,
    label: 'Move focus to the other pane',
    group: 'Split view',
    chord: ['Ctrl', 'Shift', '\\'],
    when: () => useSplitStore.getState().paneSessionIds.length === 2,
    run: () => useSplitStore.getState().focusOther()
  },
  {
    id: 'open-settings',
    icon: SettingsIcon,
    label: 'Open Settings',
    group: 'General',
    chord: ['Ctrl', ','],
    keywords: ['preferences'],
    when: () => useViewStore.getState().view !== 'settings',
    run: () => useViewStore.getState().openSettings()
  },
  {
    id: 'open-usage',
    icon: BarChart3Icon,
    label: 'Open Usage',
    group: 'General',
    when: () => useViewStore.getState().view !== 'usage',
    run: () => useViewStore.getState().openUsage()
  }
]

/** Registers the app's built-in actions; returns the unregister function. */
export function registerBuiltinActions(): () => void {
  return registerActions(BUILTIN_ACTIONS)
}
