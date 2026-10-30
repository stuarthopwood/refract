import { useEffect } from 'react'

/**
 * Stops the native WebView menu everywhere (#1404). Bubble phase on window, so a Radix
 * ContextMenu trigger (which calls preventDefault itself) has already run; `handler` receives
 * only the events no Refract menu claimed.
 */
export function useBlockNativeContextMenu(handler: (event: MouseEvent) => void): void {
  useEffect(() => {
    function onContextMenu(event: MouseEvent): void {
      if (event.defaultPrevented) return
      event.preventDefault()
      handler(event)
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [handler])
}
