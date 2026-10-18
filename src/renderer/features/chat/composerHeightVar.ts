import { useCallback, useEffect, useId, useRef } from 'react'

// Issue #980 gate round 2 fix (Medium, Code): renamed from "height" to "clearance" and measured
// from each composer's own TOP (`window.innerHeight - rect.top`), not its height alone --
// `StatusBar.tsx` (`h-9`, 36px) renders as a sibling BELOW the whole chat workspace (`App.tsx`),
// so a composer's own bottom edge never actually touches the window's bottom edge the way a
// height-only measurement assumed; height-only left the toast landing ~12px inside the
// composer's own top once the StatusBar's 36px exceeded the fixed 1.5rem (24px) gap. Measuring
// the distance from the composer's TOP to the viewport bottom naturally folds in whatever sits
// below it (the StatusBar today, or nothing, or something taller tomorrow) without hardcoding
// that height here. This module tracks every MOUNTED composer's own measured clearance (a
// `ResizeObserver` per `MessageInput` instance, split panes mount TWO, plus a `window` `resize`
// listener -- the viewport's own height can change without the composer's own size changing at
// all) and publishes the MAX of them as a CSS custom property on `<html>`, read by `sonner.tsx`'s
// own `offset`/`mobileOffset` via `calc(var(--refract-composer-clearance, 8rem) + 1.5rem)` -- so
// the toast always clears whichever composer is currently tallest, in both single-pane and split
// layouts.
const clearancesByInstance = new Map<string, number>()

function publish(): void {
  const max = clearancesByInstance.size > 0 ? Math.max(...clearancesByInstance.values()) : null
  if (max === null) {
    document.documentElement.style.removeProperty('--refract-composer-clearance')
  } else {
    document.documentElement.style.setProperty('--refract-composer-clearance', `${max}px`)
  }
}

/** Records `instanceId`'s own measured composer clearance and republishes the max across every
 *  mounted composer. `instanceId` is a React `useId()` value, stable per mount -- never
 *  `sessionId`, since `MessageInput` already remounts on every session switch
 *  (`key={sessionId}` in `ChatPane.tsx`). */
export function setComposerClearance(instanceId: string, clearancePx: number): void {
  clearancesByInstance.set(instanceId, clearancePx)
  publish()
}

/** Drops `instanceId`'s own entry (unmount) and republishes the max of whatever remains. */
export function clearComposerClearance(instanceId: string): void {
  clearancesByInstance.delete(instanceId)
  publish()
}

function measureClearance(el: HTMLElement): number {
  return window.innerHeight - el.getBoundingClientRect().top
}

/** A callback ref (not an object ref + separate `useEffect`) so a caller wires live clearance
 *  tracking onto its own root element in ONE line at the `ref={...}` JSX attribute -- the whole
 *  observe/measure/publish/unobserve lifecycle lives here, not duplicated at every call site.
 *  `instanceId` (React `useId()`) is stable per mount -- never `sessionId`, since `MessageInput`
 *  already remounts on every session switch (`key={sessionId}` in `ChatPane.tsx`). */
export function useComposerClearanceCallbackRef(): (el: HTMLElement | null) => void {
  const instanceId = useId()
  const observerRef = useRef<ResizeObserver | null>(null)
  const elRef = useRef<HTMLElement | null>(null)
  // Gate round 2 fix (Medium, Code): the viewport's own height can change (window resize) with
  // no change to the composer's own size at all, which a ResizeObserver on the composer alone
  // would never notice -- re-measures against the same element on every window `resize`.
  useEffect(() => {
    function onWindowResize(): void {
      if (elRef.current) setComposerClearance(instanceId, measureClearance(elRef.current))
    }
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [instanceId])
  return useCallback(
    (el) => {
      observerRef.current?.disconnect()
      elRef.current = el
      if (!el) {
        clearComposerClearance(instanceId)
        return
      }
      const observer = new ResizeObserver(() => setComposerClearance(instanceId, measureClearance(el)))
      observer.observe(el)
      observerRef.current = observer
    },
    [instanceId]
  )
}
