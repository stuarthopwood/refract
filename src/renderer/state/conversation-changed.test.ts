// Risk 5 audit: per-Session state keyed to a Conversation is the scroll record and the subagent selection (both cleared here;
// the global Agents panel itself stays as the user left it).
// The queue, readout, subagent list, side-chat and token-guard state are reset by the backend's `on_conversation_reset`
// hooks and arrive as their own events, so nothing else is cleared in the renderer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatAreaAnnouncer } from '../features/chat/chatAreaAnnouncer'
import { handleConversationChanged } from './conversation-changed'
import { useChatScrollStore } from './scroll-store'
import { useDraftStore } from './draft-store'
import { useSessionsStore } from './sessions-store'
import { useSplitStore } from './split-store'
import { useViewStore } from './view-store'
import { useRightPaneStore } from './right-pane-store'
import { useSubagentPanelStore } from './subagent-store'

describe('handleConversationChanged', () => {
  const announce = vi.fn()
  const realAnnounce = useChatAreaAnnouncer.getState().announce

  beforeEach(() => {
    useChatScrollStore.setState({ bySession: {}, inFlight: {} })
    useDraftStore.setState({ bySession: {} })
    useSplitStore.setState({ paneSessionIds: ['s1'], focusedIndex: 0 })
    useViewStore.setState({ view: 'chat' })
    announce.mockClear()
    useChatAreaAnnouncer.setState({ announce })
  })

  afterEach(() => {
    useChatAreaAnnouncer.setState({ announce: realAnnounce })
    vi.unstubAllGlobals()
  })

  it("clears that Session's scroll record only", () => {
    useChatScrollStore.getState().record('s1', { atEnd: false, scrollTop: 40 })
    useChatScrollStore.getState().record('s2', { atEnd: false, scrollTop: 9 })

    handleConversationChanged('s1')

    expect(useChatScrollStore.getState().bySession).toEqual({ s2: { atEnd: false, scrollTop: 9 } })
  })

  it('leaves the composer draft alone', () => {
    useDraftStore.getState().setText('s1', 'half typed')

    handleConversationChanged('s1')

    expect(useDraftStore.getState().bySession['s1']?.text).toBe('half typed')
  })

  it("clears that Session's subagent selection but leaves the global panel open", () => {
    useSubagentPanelStore.setState({ sessionId: 's1', selectedId: 'a', selectedKey: 'c1:0', streams: {} })
    useRightPaneStore.setState({ open: true, openPanelIds: ['subagents'], activePanelId: 'subagents', chatCollapsed: false })

    handleConversationChanged('s1')

    expect(useSubagentPanelStore.getState().selectedId).toBeNull()
    expect(useRightPaneStore.getState().openPanelIds).toContain('subagents')
  })

  it('is a no-op for a Session with no scroll record', () => {
    const before = useChatScrollStore.getState().bySession
    handleConversationChanged('unknown')
    expect(useChatScrollStore.getState().bySession).toBe(before)
  })

  it('announces once, politely, for a Session shown in a pane', () => {
    handleConversationChanged('s1')

    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith('Conversation changed')
  })

  it('does not announce for a Session shown in no pane', () => {
    handleConversationChanged('s2')

    expect(announce).not.toHaveBeenCalled()
  })

  it('does not announce while a view without chat panes is showing', () => {
    useViewStore.setState({ view: 'settings' })

    handleConversationChanged('s1')

    expect(announce).not.toHaveBeenCalled()
  })

  it('opens no Session and fetches no snapshot or list', () => {
    const { open, refresh } = useSessionsStore.getState()
    const openSpy = vi.fn()
    const refreshSpy = vi.fn()
    useSessionsStore.setState({ open: openSpy, refresh: refreshSpy })

    try {
      handleConversationChanged('s1')

      expect(openSpy).not.toHaveBeenCalled()
      expect(refreshSpy).not.toHaveBeenCalled()
    } finally {
      useSessionsStore.setState({ open, refresh })
    }
  })
})
