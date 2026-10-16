import { useLayoutEffect } from 'react'
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
 *  Gate round 5 fix (Main's finding 4): reads `useSessionListStore.getState().query` directly
 *  inside the cleanup, at the moment of the real unmount -- no `useSessionListStore` selector
 *  subscription (every row/group instance no longer re-renders on every query change) and no
 *  ref written during render just to smuggle a value into a later callback. `restoreInFlightRef`
 *  (optional; `useSessionRowActions.ts` passes its own `restoreRequestedRef`) skips this generic
 *  redirect while THAT row's own archive/restore flow is mid-flight -- restore already has its
 *  own explicit, more specific focus fallback (`onRestore`'s own `finish`, which also announces
 *  "Restored X"), and letting both race to move focus for the same unmount is unnecessary and
 *  unpredictable. An unrelated unmount (archive, delete) already has its own explicit focus
 *  redirect and must not be second-guessed by this one when no search is even active. */
export function useFocusSearchOnStrandedUnmount(rootRef: RefObject<HTMLElement | null>, restoreInFlightRef?: RefObject<boolean>): void {
  useLayoutEffect(() => {
    return () => {
      if (useSessionListStore.getState().query.trim() === '') return
      if (restoreInFlightRef?.current) return
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
