import { useEffect } from 'react'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { stepToMessage } from './stepToMessage'
import type { StepDirection } from './messageIndex'

/** Alt+ArrowUp / Alt+ArrowDown step to the previous / next message while keyboard focus is in
 * this Session's pane (transcript or composer). One listener per mounted pane. */
export function useMessageStepShortcut(sessionId: string): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || active.closest(OVERLAY_OPEN_SELECTOR)) return
      if (active.closest('[data-session-pane]')?.getAttribute('data-session-pane') !== sessionId) return
      event.preventDefault()
      const direction: StepDirection = event.key === 'ArrowUp' ? 'previous' : 'next'
      stepToMessage(sessionId, direction)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId])
}
