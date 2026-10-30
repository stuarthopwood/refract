import { useLayoutEffect, type RefObject } from 'react'

/** A row counts as new for this long after its Session was created. */
const NEW_ROW_WINDOW_MS = 3000

/**
 * Fades and lifts a row in only when its Session was genuinely just created (#678). Restored
 * rows, remounts after Settings, archive moves, search and group expand never animate.
 */
export function useEnterOnAppear(ref: RefObject<HTMLElement | null>, createdAt: string): void {
  useLayoutEffect(() => {
    const age = Date.now() - Date.parse(createdAt)
    if (age >= 0 && age < NEW_ROW_WINDOW_MS) ref.current?.classList.add('motion-enter')
  }, []) // mount only: the class must not be re-added on re-render
}
