// Ctrl+= / Ctrl+- / Ctrl+0 zoom the window (#825). In-window only: no global accelerators, and the
// View menu items carry no accelerator, so this keydown is the single key path.
import { useEffect } from 'react'
import type { ZoomAction } from '../../../shared/ipc'

function zoomActionFor(event: KeyboardEvent): ZoomAction | null {
  if (event.code === 'Equal' || event.code === 'NumpadAdd') return 'in'
  if (event.code === 'Minus' || event.code === 'NumpadSubtract') return 'out'
  if (event.code === 'Digit0' || event.code === 'Numpad0') return 'reset'
  return null
}

export function useZoomShortcut(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      const action = zoomActionFor(event)
      if (!action) return
      // Always cancelled so WebView2's own zoom never doubles the native step.
      event.preventDefault()
      if (event.repeat) return
      void window.refract.window.zoom(action)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
