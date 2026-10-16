import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useSessionListStore } from '@/state'
import { isFocusStranded } from '@/lib/focus'
import { focusSessionSearchInput } from './sessionSearchSelector'

/** Issue #559 gate rounds 2-3 (the #900 pattern): when a search query is active, a rename that
 *  makes `rootRef`'s own subtree (a Session row's `<li>`, or a whole Project group's own root
 *  `<div data-repository-id>`) stop matching the query unmounts it on a LATER render -- the
 *  sessions/repositories store refreshes via a separate IPC round trip, not synchronously with
 *  the rename call, so `await rename(...)` resolving tells the caller nothing about when (or
 *  whether) the filtered view actually changes. If focus was genuinely inside that subtree at
 *  that moment, it would otherwise land on `<body>`. A `useLayoutEffect` cleanup is the last
 *  point that still sees focus inside the about-to-be-removed subtree -- React detaches a
 *  deleted subtree's own refs and resets `document.activeElement` to `<body>` during the
 *  commit's mutation phase, before passive-effect cleanups run (`AskCard.tsx`'s own documented
 *  reason for the same choice, the #900 precedent this mirrors). Deferred one
 *  `requestAnimationFrame` so the commit settles first, then `isFocusStranded` (root `null`,
 *  checked globally) guards against stealing focus from anywhere it validly already moved to in
 *  that one frame.
 *
 *  Gate round 3 fix (finding 6): gated on a non-empty search query, read fresh at the moment of
 *  unmount (a ref, not a `useLayoutEffect` dependency -- toggling the query must never itself
 *  re-arm or fire this cleanup while the subtree stays mounted, only a REAL unmount may). An
 *  unrelated unmount (archive, delete) already has its own explicit focus redirect
 *  (`focusListContainer`, a confirmation dialog) and must not be second-guessed by this one when
 *  no search is even active. */
export function useFocusSearchOnStrandedUnmount(rootRef: RefObject<HTMLElement | null>): void {
  const hasQuery = useSessionListStore((state) => state.query.trim() !== '')
  const hasQueryRef = useRef(hasQuery)
  hasQueryRef.current = hasQuery

  useLayoutEffect(() => {
    return () => {
      if (!hasQueryRef.current) return
      if (!rootRef.current?.contains(document.activeElement)) return
      requestAnimationFrame(() => {
        if (!isFocusStranded(document.activeElement, null)) return
        focusSessionSearchInput()
      })
    }
    // Empty deps: registered once per instance (keyed by `session.id`/`repository.id` in the
    // parent's own `.map()`), so the cleanup fires exactly once, on this instance's real final
    // unmount -- never on the renaming/draftName re-renders that happen while it stays mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
