import { useCallback, useId, useRef } from 'react'

// Issue #980 gate round 1 fix (High, product/visual): the Toaster's bottom offset used to be a
// fixed guess at the composer's resting height -- wrong the moment a composer's own textarea
// grows past its `min-h-16` floor (up to `max-h-48`, `MessageInput.tsx`). This module tracks
// every MOUNTED composer's own measured height (a `ResizeObserver` per `MessageInput` instance,
// split panes mount TWO) and publishes the MAX of them as a CSS custom property on `<html>`,
// read by `sonner.tsx`'s own `offset`/`mobileOffset` via
// `calc(var(--refract-composer-height, 8rem) + 1.5rem)` -- so the toast always clears whichever
// composer is currently tallest, in both single-pane and split layouts.
const heightsByInstance = new Map<string, number>()

function publish(): void {
  const max = heightsByInstance.size > 0 ? Math.max(...heightsByInstance.values()) : null
  if (max === null) {
    document.documentElement.style.removeProperty('--refract-composer-height')
  } else {
    document.documentElement.style.setProperty('--refract-composer-height', `${max}px`)
  }
}

/** Records `instanceId`'s own measured composer height and republishes the max across every
 *  mounted composer. `instanceId` is a React `useId()` value, stable per mount -- never
 *  `sessionId`, since `MessageInput` already remounts on every session switch
 *  (`key={sessionId}` in `ChatPane.tsx`). */
export function setComposerHeight(instanceId: string, heightPx: number): void {
  heightsByInstance.set(instanceId, heightPx)
  publish()
}

/** Drops `instanceId`'s own entry (unmount) and republishes the max of whatever remains. */
export function clearComposerHeight(instanceId: string): void {
  heightsByInstance.delete(instanceId)
  publish()
}

/** A callback ref (not an object ref + separate `useEffect`) so a caller wires live height
 *  tracking onto its own root element in ONE line at the `ref={...}` JSX attribute -- the whole
 *  observe/measure/publish/unobserve lifecycle lives here, not duplicated at every call site.
 *  `instanceId` (React `useId()`) is stable per mount -- never `sessionId`, since `MessageInput`
 *  already remounts on every session switch (`key={sessionId}` in `ChatPane.tsx`). */
export function useComposerHeightCallbackRef(): (el: HTMLElement | null) => void {
  const instanceId = useId()
  const observerRef = useRef<ResizeObserver | null>(null)
  return useCallback(
    (el) => {
      observerRef.current?.disconnect()
      if (!el) {
        clearComposerHeight(instanceId)
        return
      }
      const observer = new ResizeObserver(() => setComposerHeight(instanceId, el.getBoundingClientRect().height))
      observer.observe(el)
      observerRef.current = observer
    },
    [instanceId]
  )
}
