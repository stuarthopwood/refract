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

/**
 * Switching motion (#678, spec 058). Returns a ref for the element whose content just changed.
 * When `switchKey` changes after the first render, the variant's enter animation restarts on that
 * same element (no remount, so scroll and state survive). The first render never animates, and a
 * switch within `RAPID_SWITCH_MS` of the previous one clears the animation instead of restarting it.
 */
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
    if (rapid) return
    void el.offsetWidth // restart the animation
    el.classList.add(className)
  }, [switchKey, variant])

  return ref
}
