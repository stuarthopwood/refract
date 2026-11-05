// One shared hover/focus controller for the Todo and Agents readout cards. Not a Radix HoverCard/Tooltip: the
// anchor button already has its own click behaviour and those triggers want exclusive ownership of its events.
// The card body has no focus trap; its one link is tabIndex -1, so keyboard focus stays on the anchor. (#700)
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent, PointerEvent, RefObject } from 'react'

const OPEN_DELAY_MS = 400
// Covers the small `sideOffset` gap between anchor and content without letting the card linger.
const CLOSE_GRACE_MS = 150

type TimerHandle = ReturnType<typeof setTimeout>

/** Clears a pending timer and nulls the ref so a fired handle never reads as still scheduled. */
function clearTimer(ref: { current: TimerHandle | null }) {
  if (ref.current) {
    clearTimeout(ref.current)
    ref.current = null
  }
}

export interface ReadoutCardAnchorHandlers {
  onPointerEnter: () => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
  onFocus: (event: FocusEvent<HTMLElement>) => void
  onBlur: () => void
}

export interface ReadoutCardContentHandlers {
  onPointerEnter: () => void
  onPointerLeave: () => void
}

export interface ReadoutCard {
  open: boolean
  /** Anchor chip ref; `scheduleClose` reads it to tell a keyboard-focused anchor from a grazed one. */
  anchorRef: RefObject<HTMLButtonElement | null>
  anchorHandlers: ReadoutCardAnchorHandlers
  contentHandlers: ReadoutCardContentHandlers
  /** Closes the card and cancels a pending hover-open (for outside clicks, Escape and anchor clicks). */
  close: () => void
}

/** `disabled` forces `open` false and ignores hover/focus without the caller returning before this hook. */
export function useReadoutCard({ disabled = false }: { disabled?: boolean } = {}): ReadoutCard {
  const [open, setOpen] = useState(false)
  const openTimerRef = useRef<TimerHandle | null>(null)
  const closeTimerRef = useRef<TimerHandle | null>(null)
  // True while the pointer is over the anchor or the content, which keeps the card hoverable.
  const hoveringRef = useRef(false)
  // Hover opens from a real pointer move, not from enter: Chromium synthesises an enter (and a move at the
  // same coordinates) when the chip remounts under a parked pointer, which must not reopen the card.
  const lastMoveRef = useRef<{ x: number; y: number } | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)

  const close = useCallback(() => {
    clearTimer(openTimerRef)
    clearTimer(closeTimerRef)
    setOpen(false)
  }, [])

  useEffect(() => {
    return () => {
      clearTimer(openTimerRef)
      clearTimer(closeTimerRef)
      hoveringRef.current = false
      lastMoveRef.current = null
    }
  }, [])
  // A disabled chip gets no pointerleave/blur, so stale hover state would reopen the card when re-enabled.
  useEffect(() => {
    if (!disabled) return
    hoveringRef.current = false
    lastMoveRef.current = null
    close()
  }, [disabled, close])

  // Content has no focusable element, so a window listener (capture phase) handles Escape; capture and
  // stopPropagation keep it from reaching MessageInput's composer-clear handler and wiping the draft.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, close])

  // A keyboard-opened card survives the pointer grazing past; focus is checked when the grace window elapses.
  const scheduleClose = () => {
    clearTimer(closeTimerRef)
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      if (hoveringRef.current) return
      if (anchorRef.current?.matches(':focus-visible')) return
      setOpen(false)
    }, CLOSE_GRACE_MS)
  }

  const onPointerEnter = () => {
    if (disabled) return
    hoveringRef.current = true
    clearTimer(closeTimerRef)
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (disabled) return
    const last = lastMoveRef.current
    if (last && last.x === event.clientX && last.y === event.clientY) return
    lastMoveRef.current = { x: event.clientX, y: event.clientY }
    hoveringRef.current = true
    if (open || openTimerRef.current) return
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null
      setOpen(true)
    }, OPEN_DELAY_MS)
  }
  const onPointerLeave = () => {
    lastMoveRef.current = null
    hoveringRef.current = false
    clearTimer(openTimerRef)
    scheduleClose()
  }
  // Focus-visible only, so a click that also focuses the button doesn't double up with the hover open.
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (disabled) return
    if (!event.target.matches(':focus-visible')) return
    clearTimer(closeTimerRef)
    setOpen(true)
  }
  const onBlur = () => {
    if (!hoveringRef.current) close()
  }
  const onContentPointerEnter = () => {
    hoveringRef.current = true
    clearTimer(closeTimerRef)
  }
  const onContentPointerLeave = () => {
    hoveringRef.current = false
    scheduleClose()
  }

  return {
    open,
    anchorRef,
    anchorHandlers: { onPointerEnter, onPointerMove, onPointerLeave, onFocus, onBlur },
    contentHandlers: { onPointerEnter: onContentPointerEnter, onPointerLeave: onContentPointerLeave },
    close
  }
}
