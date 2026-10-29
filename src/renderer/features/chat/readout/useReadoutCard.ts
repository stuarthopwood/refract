// Issue #700/#701 slice (b), decision record item 1: "Non-modal Popover that opens on hover
// after about 400ms and on keyboard focus, Esc closes, hoverable, opens upward, hidden when
// empty." One shared controller for both the Todo and Agents hover-focus cards
// (`Readouts.tsx`'s `TodoProgressReadout`/`SubagentsReadout`), so the two never drift onto
// slightly different timings or Escape/hover-through behaviour.
//
// Deliberately NOT a Radix `HoverCard`/`Tooltip` (the decision record's own "not PopoverTrigger,
// Tooltip or HoverCard" line): both cards sit on a `<button>` that ALREADY has its own click
// behaviour (pin-toggle / open-panel) wired through `ReadoutItem`'s `onActivate`, so a
// `HoverCard`/`Tooltip`'s own `Trigger` (which also handles the open/close state machine AND
// wants exclusive ownership of the anchor's events) would fight that -- `PopoverAnchor` is purely
// a positioning reference with no opinions of its own, so this hook is free to drive `open`
// however it wants.
//
// The card's own content is inert text (decision record: "elapsed time... inert text",
// "tasks with glyph plus word... inert text") -- nothing inside it is ever focused, so there is
// no focus-trap/restore concern; Escape while open always moves focus back to wherever it
// already was (the anchor, if this was opened by keyboard; untouched, if opened by hover alone).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent, RefObject } from 'react'

const OPEN_DELAY_MS = 400
// Grace window between "pointer left the anchor" and "pointer entered the content": long enough
// for a real mouse move across the small gap a `sideOffset` leaves, short enough that the card
// never lingers open once the pointer is genuinely gone.
const CLOSE_GRACE_MS = 150

/** Named once so every `useRef`/parameter below reads this, never a repeated
 * `ReturnType<typeof setTimeout>` inline at each use site. */
type TimerHandle = ReturnType<typeof setTimeout>

/** The only place a `clearTimeout` call is guarded in this file: the guarded branch also resets
 * the ref to `null`, which is genuine extra work (a stale, already-fired handle must never read
 * as "still scheduled" to a later check), not a bare redundant clear. */
function clearTimer(ref: { current: TimerHandle | null }) {
  if (ref.current) {
    clearTimeout(ref.current)
    ref.current = null
  }
}

export interface ReadoutCardAnchorHandlers {
  onPointerEnter: () => void
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
  /** Attach to the anchor chip's own `ref` (`ReadoutItem` forwards one) -- `scheduleClose`
   * below reads this to tell a genuinely keyboard-focused anchor apart from one the pointer
   * merely grazed on its way elsewhere (gate round 1 fix 11). */
  anchorRef: RefObject<HTMLButtonElement | null>
  anchorHandlers: ReadoutCardAnchorHandlers
  contentHandlers: ReadoutCardContentHandlers
  /** For `Popover`'s own `onOpenChange` (e.g. a real outside click), the Escape handler, and a
   * click on the anchor itself (gate round 1 fix 10: cancels a still-pending hover-open timer
   * so the card never pops up over whatever the click just opened/toggled). */
  close: () => void
}

/** `disabled` (the Todo card's own "never opens while pinned", the Agents card's own "never
 * opens with nothing running", decision item 1 plus gate round 1 fix 2): forces `open` false
 * and ignores every hover/focus trigger, without the caller needing its own early return before
 * this hook runs (hooks must run unconditionally). */
export function useReadoutCard({ disabled = false }: { disabled?: boolean } = {}): ReadoutCard {
  const [open, setOpen] = useState(false)
  const openTimerRef = useRef<TimerHandle | null>(null)
  const closeTimerRef = useRef<TimerHandle | null>(null)
  // True while the pointer is over the anchor OR the content -- the one piece of state that
  // makes the card "hoverable" (decision item 1) rather than closing the instant the pointer
  // leaves the anchor on its way to the content below/above it.
  const hoveringRef = useRef(false)
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
    }
  }, [])
  useEffect(() => {
    if (disabled) close()
  }, [disabled, close])

  // Escape (decision item 1: "Esc closes"): content holds no focusable element of its own, so
  // there is nothing to catch a React `onKeyDown` -- a window listener, scoped to while open,
  // catches it regardless of whether focus is on the anchor (keyboard-opened) or nowhere in
  // particular (hover-opened). Never moves focus itself: the anchor already has it in the
  // keyboard case, and there is nothing to restore it to in the hover case.
  //
  // Gate round 1 fix 3: registered on the CAPTURE phase (the final `true` argument), and both
  // `preventDefault`/`stopPropagation` are called -- a bubble-phase listener let this SAME
  // Escape keypress also reach `MessageInput.tsx`'s own composer-clear handler (attached to the
  // textarea, which keydown events bubble through to `window` regardless of where the card
  // itself is positioned), silently wiping the draft the instant a hover-opened card closed.
  // Capturing at `window`, above the textarea in the tree, intercepts the event before it ever
  // reaches that handler at all; `MessageInput.tsx`'s own matching defensive check
  // (`event.defaultPrevented`) is the belt to this capture's suspenders.
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

  // Gate round 1 fix 11: a keyboard-opened card must survive the pointer merely passing over
  // the anchor or content on its way elsewhere (the pointer never "arrived" with intent the way
  // a deliberate hover does) -- skip the close while the anchor itself still carries genuine
  // keyboard focus, checked fresh at the moment the grace window elapses rather than cached up
  // front (focus can move during the grace window too).
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
    if (open || openTimerRef.current) return
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null
      setOpen(true)
    }, OPEN_DELAY_MS)
  }
  const onPointerLeave = () => {
    hoveringRef.current = false
    clearTimer(openTimerRef)
    scheduleClose()
  }
  // Keyboard focus-visible only (decision item 1: "on keyboard focus"): a mouse click that
  // happens to also focus the button must not ALSO open the card on a 0ms delay, doubling up
  // with the hover path above, which already owns a pointer-driven open.
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
    anchorHandlers: { onPointerEnter, onPointerLeave, onFocus, onBlur },
    contentHandlers: { onPointerEnter: onContentPointerEnter, onPointerLeave: onContentPointerLeave },
    close
  }
}
