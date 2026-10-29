// Ctrl+F opens chat Find, but only while keyboard focus is inside this Session's chat pane (the
// transcript or composer); Settings, the Explorer, dialogs and other panes never trigger it.
import { useEffect } from 'react'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { openChatFind } from '@/state/chat-find-store'

export function useChatFindShortcut(sessionId: string): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== 'f') return
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || active.closest(OVERLAY_OPEN_SELECTOR)) return
      if (active.closest('[data-session-pane]')?.getAttribute('data-session-pane') !== sessionId) return
      event.preventDefault()
      if (!event.repeat) openChatFind(sessionId, active)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId])
}
