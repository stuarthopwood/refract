// Ctrl+R / Shift+Ctrl+R cycles the role (#766 part B). One listener per chat pane's composer; it
// acts only while keyboard focus is inside ITS OWN pane (`[data-session-pane]`, the transcript or
// composer), so Settings, dialogs and the Explorer never trigger it, and in a split only the
// focused pane's Session cycles.
import { useEffect } from 'react'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { cycleRole } from './roleCycleStore'

export const OPEN_ROLE_SWITCHER_EVENT = 'refract:open-role-switcher'

export function useRoleCycleShortcut(sessionId: string): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== 'r') return
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || active.closest(OVERLAY_OPEN_SELECTOR)) return
      if (active.closest('[data-session-pane]')?.getAttribute('data-session-pane') !== sessionId) return
      event.preventDefault()
      if (event.repeat) return
      void cycleRole(sessionId, event.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId])
}

/** Bare `/role` (MessageInput) opens the pane's switcher. */
export function openRoleSwitcher(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_ROLE_SWITCHER_EVENT, { detail: sessionId }))
}
