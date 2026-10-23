import { useCallback, useEffect, useRef, useState } from 'react'

/** A live-region's announced text, auto-cleared a few seconds after being set (default 6s) so a
 *  screen-reader user who tabs back into the region later does not re-read a stale announcement
 *  (e.g. "Added GitHub account ..." from several actions ago). Each call to the returned
 *  `announce` cancels any previous pending clear; the pending timer is also cleared on unmount.
 *  `announce` is stable across renders (`useCallback`, #563 gate round 2): safe to list in an
 *  effect's own dependency array, not only call from an event handler. */
export function useClearedAnnouncement(clearMs = 6000): [string, (text: string) => void] {
 const [text, setText] = useState('')
 // `0` (never a real timer id) instead of `null`: `clearTimeout`/`clearInterval` are no-ops for
 // any id with no live timer, so a plain unconditional `clearTimeout(ref.current)` below is
 // always safe and needs no truthiness guard first.
 const timeoutRef = useRef<number>(0)
 const pendingRef = useRef<number>(0)

 useEffect(() => {
  return () => {
   clearTimeout(timeoutRef.current)
   clearTimeout(pendingRef.current)
  }
 }, [])

 const announce = useCallback(
  (next: string): void => {
   clearTimeout(timeoutRef.current)
   clearTimeout(pendingRef.current)
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
  },
  [clearMs]
 )

 return [text, announce]
}
