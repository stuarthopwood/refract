import { useLayoutEffect, useRef, type RefObject } from 'react'

// Full class names are literals so Tailwind sees them (`motion-*` utilities live in globals.css).
const VARIANT_CLASS = {
  view: 'motion-enter',
  fade: 'motion-enter-fade',
  panel: 'motion-enter-panel',
  crossfade: 'motion-crossfade',
  tabs: 'motion-tab-underline'
} as const

export type EnterVariant = keyof typeof VARIANT_CLASS

/** A switch sooner than this (= `--motion-base`) after the previous one skips straight to the final state. */
const RAPID_SWITCH_MS = 150

/** Restarts the variant's enter animation on the returned ref's element when `switchKey` changes (#678). Skips the first render, a null key and rapid switches. */
export function useEnterOnSwitch<T extends HTMLElement = HTMLDivElement>(
  switchKey: unknown,
  variant: EnterVariant,
  existingRef?: RefObject<T | null>
): RefObject<T | null> {
  const ownRef = useRef<T | null>(null)
  const ref = existingRef ?? ownRef
  const prevKey = useRef(switchKey)
  const lastSwitchAt = useRef(0)

  useLayoutEffect(() => {
    if (Object.is(prevKey.current, switchKey)) return
    prevKey.current = switchKey
    const el = ref.current
    if (!el) return
    const now = performance.now()
    const rapid = now - lastSwitchAt.current < RAPID_SWITCH_MS
    lastSwitchAt.current = now
    const className = VARIANT_CLASS[variant]
    el.classList.remove(className)
    if (rapid || switchKey == null) return
    void el.offsetWidth // restart the animation
    el.classList.add(className)
  }, [switchKey, variant])

  return ref
}
