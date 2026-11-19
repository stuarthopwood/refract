import { useCallback, useEffect, useLayoutEffect, useRef, type UIEvent } from 'react'

/**
 * Restores a scroller to `initial` once its content is `ready`, then hands the last position to `save` when the view unmounts.
 * Saving on unmount, not per scroll event, keeps scrolling out of the store.
 */
export function useScrollMemory<T extends HTMLElement>(ready: boolean, initial: number | undefined, save: (scrollTop: number) => void) {
  const ref = useRef<T>(null)
  const lastRef = useRef(initial ?? 0)
  const restoredRef = useRef(false)
  const saveRef = useRef(save)

  useEffect(() => {
    saveRef.current = save
  })

  useLayoutEffect(() => {
    if (!ready || restoredRef.current || !ref.current) return
    restoredRef.current = true
    ref.current.scrollTop = lastRef.current
  }, [ready])

  useEffect(() => () => saveRef.current(lastRef.current), [])

  // Scroll events before the restore are the browser starting at the top, not the reader's position.
  const onScroll = useCallback((event: UIEvent<T>) => {
    if (restoredRef.current) lastRef.current = event.currentTarget.scrollTop
  }, [])

  return { ref, onScroll }
}
