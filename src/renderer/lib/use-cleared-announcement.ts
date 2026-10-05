import { useEffect, useRef, useState } from 'react'

/** A live-region's announced text, auto-cleared a few seconds after being set (default 6s) so a
 *  screen-reader user who tabs back into the region later does not re-read a stale announcement
 *  (e.g. "Added GitHub account ..." from several actions ago). Each call to the returned
 *  `announce` cancels any previous pending clear; the pending timer is also cleared on unmount. */
export function useClearedAnnouncement(clearMs = 6000): [string, (text: string) => void] {
  const [text, setText] = useState('')
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function announce(next: string): void {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setText(next)
    timeoutRef.current = setTimeout(() => setText(''), clearMs)
  }

  return [text, announce]
}
