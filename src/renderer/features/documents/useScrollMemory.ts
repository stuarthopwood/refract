import { useCallback, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react'
import { createScrollMemory } from './scroll-memory'

/**
 * Restores a scroller to `initial` once its content is `ready`, then hands the last position to `save` when the view unmounts.
 * Saving on unmount, not per scroll event, keeps scrolling out of the store.
 */
export function useScrollMemory<T extends HTMLElement>(ready: boolean, initial: number | undefined, save: (scrollTop: number) => void) {
  const ref = useRef<T>(null)
  const [memory] = useState(() => createScrollMemory(initial))
  const saveRef = useRef(save)

  useEffect(() => {
    saveRef.current = save
  })

  useLayoutEffect(() => {
    const target = memory.restore(ready, ref.current !== null)
    if (target !== null && ref.current) ref.current.scrollTop = target
  }, [ready, memory])

  useEffect(() => () => saveRef.current(memory.last()), [memory])

  const onScroll = useCallback((event: UIEvent<T>) => memory.track(event.currentTarget.scrollTop), [memory])

  return { ref, onScroll }
}
