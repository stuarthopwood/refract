import { useEffect } from 'react'
import { chordMatches, findAction } from './actionRegistry'
import { OVERLAY_OPEN_SELECTOR } from '@/lib/overlayOpenSelector'
import { usePaletteStore } from './paletteStore'

/** Ctrl+K and Ctrl+Shift+P toggle the palette; chords come from the `open-palette` action. */
export function usePaletteShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || event.isComposing) return
      const action = findAction('open-palette')
      if (!action) return
      const hit = (action.chord && chordMatches(event, action.chord)) || (action.aliasChord && chordMatches(event, action.aliasChord))
      if (!hit) return
      // The Markdown editor's Ctrl+K (insert link) handles the event first and keeps it.
      if (event.defaultPrevented) return
      const { open, setOpen } = usePaletteStore.getState()
      if (!open && document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      setOpen(!open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
