// Spec 024 FR-002: Ctrl+Shift+B toggles the right pane, window-wide, in the chat view only.
// Matched on `event.key` (like Ctrl+W in App.tsx); Alt is excluded so AltGr never fires it, and
// Ctrl+B alone stays reserved for the Session list (#453).
import { useEffect } from 'react'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { toggleRightPane } from './toggle-right-pane'

export function useRightPaneShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.repeat || event.isComposing) return
      if (event.key.toLowerCase() !== 'b') return
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      toggleRightPane()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
