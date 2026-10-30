import { useCallback, useEffect, useId, useRef } from 'react'

// Clearance = `innerHeight - composer top`, so it includes whatever sits below the composer (the StatusBar). (#980)
// Publishes the max across mounted composers (split view mounts two) as `--refract-composer-clearance`, read by `sonner.tsx`.
const clearancesByInstance = new Map<string, number>()

function publish(): void {
  const max = clearancesByInstance.size > 0 ? Math.max(...clearancesByInstance.values()) : null
  if (max === null) {
    document.documentElement.style.removeProperty('--refract-composer-clearance')
  } else {
    document.documentElement.style.setProperty('--refract-composer-clearance', `${max}px`)
  }
}

/** Records one composer's clearance (keyed by `useId()`, not sessionId) and republishes the max. */
export function setComposerClearance(instanceId: string, clearancePx: number): void {
  clearancesByInstance.set(instanceId, clearancePx)
  publish()
}

/** Drops one composer's entry on unmount and republishes. */
export function clearComposerClearance(instanceId: string): void {
  clearancesByInstance.delete(instanceId)
  publish()
}

function measureClearance(el: HTMLElement): number {
  return window.innerHeight - el.getBoundingClientRect().top
}

/** Callback ref that tracks a composer's clearance for its whole observe/publish lifecycle. */
export function useComposerClearanceCallbackRef(): (el: HTMLElement | null) => void {
  const instanceId = useId()
  const observerRef = useRef<ResizeObserver | null>(null)
  const elRef = useRef<HTMLElement | null>(null)
  // A window resize changes clearance without resizing the composer, which the observer would miss.
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
