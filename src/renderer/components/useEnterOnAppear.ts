import { useEffect, useLayoutEffect, type RefObject } from 'react'

// Parent effects run after child layout effects, so the commit that first shows a list's rows
// finishes before the list calls `markEnterListSettled`; only later mounts animate.
let settled = false

/** Call from the list container once its first non-empty set of rows has rendered. */
export function useMarkEnterListSettled(hasRows: boolean): void {
  useEffect(() => {
    if (hasRows) settled = true
  }, [hasRows])
}

/** Fades and lifts a row in when it appears after first paint (new session, group expand). Mount only. */
export function useEnterOnAppear(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (settled) ref.current?.classList.add('motion-enter')
  }, [])
}
