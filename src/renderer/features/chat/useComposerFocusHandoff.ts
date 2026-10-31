// #1285: keeps focus off <body> when the composer disables or re-enables around a stop.
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { focusStopBanner, isFocusStranded } from '@/lib/focus'

interface Options {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  isWorking: boolean
  disabled: boolean
  /** True while the Stop button (which vanishes when the turn ends) holds focus; cleared once consumed. */
  stopHadFocusRef: RefObject<boolean>
}

export function useComposerFocusHandoff({ textareaRef, isWorking, disabled, stopHadFocusRef }: Options): void {
  const wasDisabled = useRef(disabled)

  // Layout effect: no frame without a focus ring.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    const pane = textarea?.closest<HTMLElement>('[data-session-pane]') ?? null
    const active = document.activeElement
    const stranded = isFocusStranded(active, pane)
    const becameDisabled = disabled && !wasDisabled.current
    const becameEnabled = !disabled && wasDisabled.current
    wasDisabled.current = disabled

    if (disabled) {
      const stopTookFocus = !isWorking && stopHadFocusRef.current
      if (stopTookFocus) stopHadFocusRef.current = false
      if ((stopTookFocus || becameDisabled) && (stranded || active === textarea)) focusStopBanner(pane)
      return
    }
    if (!isWorking && stopHadFocusRef.current) {
      stopHadFocusRef.current = false
      if (stranded) textarea?.focus()
      return
    }
    if (becameEnabled && (active === document.body || !active || active.closest('[data-pane-banner]'))) textarea?.focus()
  }, [isWorking, disabled, textareaRef, stopHadFocusRef])
}
