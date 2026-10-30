import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"

// The id of the one open menu root (#1404). Roots only ever close each other; a context menu is never opened from state.
let openId: string | null = null
const listeners = new Set<() => void>()

function setOpenId(id: string | null): void {
  openId = id
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True while any menu root is open. */
export function useAnyMenuOpen(): boolean {
  return useSyncExternalStore(subscribe, () => openId !== null)
}

/** True while another menu is open, so a closing menu must not steal focus back from it. */
export function isMenuOpen(): boolean {
  return openId !== null
}

/** Controlled open state for a menu root that closes itself when another root opens; keeps the root's own open/onOpenChange props working. */
export function useExclusiveMenu(openProp: boolean | undefined, defaultOpen: boolean | undefined, onOpenChange: ((open: boolean) => void) | undefined) {
  const id = useId()
  const [inner, setInner] = useState(defaultOpen ?? false)
  const open = openProp ?? inner
  const openRef = useRef(open)
  openRef.current = open
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  function change(next: boolean): void {
    setInner(next)
    onOpenChangeRef.current?.(next)
  }
  const changeRef = useRef(change)
  changeRef.current = change

  useEffect(() => {
    if (!open) return
    setOpenId(id)
    return () => {
      if (openId === id) setOpenId(null)
    }
  }, [open, id])

  useEffect(() => {
    if (!open) return
    return subscribe(() => {
      if (openRef.current && openId !== null && openId !== id) changeRef.current(false)
    })
  }, [open, id])

  return { open, onOpenChange: change }
}
