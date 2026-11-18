// Risk 5 audit: per-Session state keyed to a Conversation is the scroll record (cleared here). The queue, readout,
// subagent, side-chat and token-guard state are reset by the backend's `on_conversation_reset` hooks and arrive as
// their own events, so nothing else is cleared in the renderer.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleConversationChanged } from './conversation-changed'
import { useChatScrollStore } from './scroll-store'
import { useDraftStore } from './draft-store'
import { useSessionsStore } from './sessions-store'

describe('handleConversationChanged', () => {
  beforeEach(() => {
    useChatScrollStore.setState({ bySession: {}, inFlight: {} })
    useDraftStore.setState({ bySession: {} })
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

  it('opens nothing and applies no snapshot', () => {
    const open = vi.fn()
    const applySnapshot = vi.fn()
    useSessionsStore.setState({ open, applySnapshot } as never)

    handleConversationChanged('s1')

    expect(open).not.toHaveBeenCalled()
    expect(applySnapshot).not.toHaveBeenCalled()
  })

  it('is a no-op for a Session with no scroll record', () => {
    const before = useChatScrollStore.getState().bySession
    handleConversationChanged('unknown')
    expect(useChatScrollStore.getState().bySession).toBe(before)
  })

  it('serves two panes of one Session through the single store entry', () => {
    useChatScrollStore.getState().record('s1', { atEnd: false, scrollTop: 5 })
    handleConversationChanged('s1')
    // Both panes read the same entry, so both now land at the end.
    expect(useChatScrollStore.getState().bySession['s1']).toBeUndefined()
  })
})
