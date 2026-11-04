import { useRef } from 'react'

/** Keeps focus in the panel a menu item pinned; Radix would otherwise hand it back to the trigger on close. */
export function usePinFromMenu() {
  const pinnedRef = useRef(false)
  return {
    markPinned: () => {
      pinnedRef.current = true
    },
    onCloseAutoFocus: (event: Event) => {
      if (pinnedRef.current) event.preventDefault()
      pinnedRef.current = false
    }
  }
}
