import { useEffect, useRef, useState } from 'react'

/** A live-region's announced text, auto-cleared a few seconds after being set (default 6s) so a
 *  screen-reader user who tabs back into the region later does not re-read a stale announcement
 *  (e.g. "Added GitHub account ..." from several actions ago). Each call to the returned
 *  `announce` cancels any previous pending clear; the pending timer is also cleared on unmount. */
export function useClearedAnnouncement(clearMs = 6000): [string, (text: string) => void] {
 const [text, setText] = useState('')
 const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
 const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null)

 useEffect(() => {
  return () => {
   if (timeoutRef.current) clearTimeout(timeoutRef.current)
   if (pendingRef.current) clearTimeout(pendingRef.current)
  }
 }, [])

 function announce(next: string): void {
  if (timeoutRef.current) clearTimeout(timeoutRef.current)
  if (pendingRef.current) clearTimeout(pendingRef.current)
  // Quality-gate remediation (accessibility-auditor Low): clearing to '' first and setting the
  // real text on the next tick, rather than in the same update, forces the live region's text
  // to actually change in the DOM between the two -- otherwise announcing text identical to
  // what was already there (e.g. two failed sign-ins in a row) silently no-ops, since nothing
  // about the node changed for the screen reader to notice.
  setText('')
  pendingRef.current = setTimeout(() => {
   setText(next)
   timeoutRef.current = setTimeout(() => setText(''), clearMs)
  }, 0)
 }

 return [text, announce]
}
