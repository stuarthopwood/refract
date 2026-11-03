import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import { useSessionListStore } from '@/state'
import { isFocusStranded } from '@/lib/focus'
import { focusSessionSearch } from './sessionSearchSelector'

/** Refocuses the search input (or the funnel while the panel is closed) when an active query's rename unmounts the focused element inside `rootRef`. */
export function useFocusSearchOnStrandedUnmount(
  rootRef: RefObject<HTMLElement | null>,
  restoreInFlightRef?: RefObject<boolean>,
  enabled = true
): void {
  useLayoutEffect(() => {
    if (!enabled) return
    return () => {
      if (useSessionListStore.getState().query.trim() === '') return
      if (restoreInFlightRef?.current) return
      if (!rootRef.current?.contains(document.activeElement)) return
      requestAnimationFrame(() => {
        if (!isFocusStranded(document.activeElement, null)) return
        focusSessionSearch()
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
