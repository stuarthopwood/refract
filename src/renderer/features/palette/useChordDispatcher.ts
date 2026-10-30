import { useEffect } from 'react'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { chordMatches, getActions, isActionEnabled } from './actionRegistry'

// Ctrl+K and Ctrl+Shift+P stay with usePaletteShortcut (it honours a defaultPrevented Ctrl+K).
const PALETTE_ACTION_ID = 'open-palette'

/** Runs the enabled registry action whose chord matches a window keydown. */
export function useChordDispatcher(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      for (const action of getActions()) {
        if (action.id === PALETTE_ACTION_ID) continue
        const matched = [action.chord, action.aliasChord].some((chord) => chord && chordMatches(event, chord))
        if (!matched) continue
        if (action.chordUnguarded) {
          event.preventDefault()
          if (isActionEnabled(action)) action.run()
          return
        }
        if (event.repeat || event.isComposing) continue
        if (!isActionEnabled(action)) continue
        if (document.querySelector(OVERLAY_OPEN_SELECTOR)) continue
        event.preventDefault()
        action.run()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
