import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'

// Issue #730 (spec 001 FR-113, FR-116): one reorder implementation for any list of items, so the
// right pane's icon rail now and #638's repository list later share it. Pointer drag after a few
// pixels (a plain click is left alone), Esc cancels, Alt+Shift+Arrow moves the focused item (the
// WCAG 2.5.7 alternative), every move is announced politely, and the moved item keeps focus. No
// animation is used, so reduced-motion preferences are respected by construction.

export const REORDER_DRAG_THRESHOLD_PX = 6

/** Tailwind classes an item adds so the hook's `data-reorder-marker` draws the insertion bar on
 * the item's near edge (items must be `relative`). */
export const REORDER_MARKER_CLASS =
  "data-[reorder-marker=before]:before:absolute data-[reorder-marker=before]:before:inset-x-0 data-[reorder-marker=before]:before:-top-[3px] data-[reorder-marker=before]:before:h-0.5 data-[reorder-marker=before]:before:rounded data-[reorder-marker=before]:before:bg-ring data-[reorder-marker=before]:before:content-[''] data-[reorder-marker=after]:after:absolute data-[reorder-marker=after]:after:inset-x-0 data-[reorder-marker=after]:after:-bottom-[3px] data-[reorder-marker=after]:after:h-0.5 data-[reorder-marker=after]:after:rounded data-[reorder-marker=after]:after:bg-ring data-[reorder-marker=after]:after:content-['']"

export interface UseReorderableOptions {
  /** Current item ids in display order. */
  ids: readonly string[]
  /** The spoken name of an item, for "<name>, position N of M". */
  labelFor: (id: string) => string
  /** Called with the full new order after a drag or keyboard move. */
  onReorder: (ids: string[]) => void
  /** 'y' for a vertical list (Alt+Shift+Up/Down), 'x' for a horizontal one (Left/Right). */
  axis?: 'x' | 'y'
}

export interface ReorderItemProps {
  'data-reorder-id': string
  'data-reorder-dragging'?: true
  'data-reorder-marker'?: 'before' | 'after'
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void
  onClickCapture: (event: MouseEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

interface Gesture {
  id: string
  pointerId: number
  startPos: number
  dragging: boolean
  cancelled: boolean
}

export function useReorderable({ ids, labelFor, onReorder, axis = 'y' }: UseReorderableOptions) {
  const containerRef = useRef<HTMLElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const suppressClickRef = useRef(false)
  const pendingFocusRef = useRef<string | null>(null)
  const [dragging, setDragging] = useState<{ id: string; insertAt: number } | null>(null)
  const [announcement, setAnnouncement] = useState({ text: '', serial: 0 })

  const announce = useCallback((text: string) => setAnnouncement((prev) => ({ text, serial: prev.serial + 1 })), [])

  // A moved element is detached and re-inserted by the reorder, which drops focus in Chromium.
  useLayoutEffect(() => {
    const id = pendingFocusRef.current
    if (id === null) return
    pendingFocusRef.current = null
    const items = containerRef.current?.querySelectorAll<HTMLElement>('[data-reorder-id]') ?? []
    for (const item of items) if (item.dataset.reorderId === id) item.focus()
  }, [ids])

  const insertionAt = useCallback(
    (pointer: number): number => {
      const items = containerRef.current?.querySelectorAll<HTMLElement>('[data-reorder-id]') ?? []
      let at = 0
      for (const item of items) {
        const rect = item.getBoundingClientRect()
        const mid = axis === 'y' ? rect.top + rect.height / 2 : rect.left + rect.width / 2
        if (pointer > mid) at += 1
      }
      return at
    },
    [axis]
  )

  const pointerPos = (event: PointerEvent<HTMLElement>): number => (axis === 'y' ? event.clientY : event.clientX)

  const cancelDrag = useCallback(() => {
    if (gestureRef.current) gestureRef.current.cancelled = true
    setDragging(null)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancelDrag()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [dragging, cancelDrag])

  function finish(event: PointerEvent<HTMLElement>, commit: boolean): void {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const wasDrag = gesture.dragging
    setDragging(null)
    if (!wasDrag) return
    // The click that follows a drag's pointerup must not toggle the item.
    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
    if (!commit || gesture.cancelled) return
    const from = ids.indexOf(gesture.id)
    let to = insertionAt(pointerPos(event))
    if (to > from) to -= 1
    if (from < 0 || to === from) return
    const next = ids.filter((id) => id !== gesture.id)
    next.splice(to, 0, gesture.id)
    pendingFocusRef.current = gesture.id
    onReorder(next)
    announce(`${labelFor(gesture.id)} moved to position ${to + 1} of ${ids.length}`)
  }

  function onKeyDownFor(id: string, event: KeyboardEvent<HTMLElement>): void {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return
    const backKey = axis === 'y' ? 'ArrowUp' : 'ArrowLeft'
    const forwardKey = axis === 'y' ? 'ArrowDown' : 'ArrowRight'
    if (event.key !== backKey && event.key !== forwardKey) return
    event.preventDefault()
    const from = ids.indexOf(id)
    if (from < 0) return
    const to = Math.min(ids.length - 1, Math.max(0, from + (event.key === forwardKey ? 1 : -1)))
    if (to !== from) {
      const next = [...ids]
      next.splice(from, 1)
      next.splice(to, 0, id)
      pendingFocusRef.current = id
      onReorder(next)
    }
    announce(`${labelFor(id)}, position ${to + 1} of ${ids.length}`)
  }

  const fromIndex = dragging ? ids.indexOf(dragging.id) : -1
  // Dropping where the item already sits changes nothing, so no bar is drawn there.
  const insertionIndex = dragging && dragging.insertAt !== fromIndex && dragging.insertAt !== fromIndex + 1 ? dragging.insertAt : null

  function getItemProps(id: string): ReorderItemProps {
    const index = ids.indexOf(id)
    let marker: 'before' | 'after' | undefined
    if (insertionIndex !== null) {
      if (insertionIndex === index) marker = 'before'
      else if (insertionIndex === ids.length && index === ids.length - 1) marker = 'after'
    }
    return {
      'data-reorder-id': id,
      ...(dragging?.id === id ? { 'data-reorder-dragging': true as const } : {}),
      ...(marker ? { 'data-reorder-marker': marker } : {}),
      onPointerDown: (event) => {
        if (event.button !== 0 || event.pointerType === 'touch') return
        gestureRef.current = { id, pointerId: event.pointerId, startPos: pointerPos(event), dragging: false, cancelled: false }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove: (event) => {
        const gesture = gestureRef.current
        if (!gesture || gesture.pointerId !== event.pointerId || gesture.cancelled) return
        if (!gesture.dragging) {
          if (Math.abs(pointerPos(event) - gesture.startPos) < REORDER_DRAG_THRESHOLD_PX) return
          gesture.dragging = true
        }
        setDragging({ id: gesture.id, insertAt: insertionAt(pointerPos(event)) })
      },
      onPointerUp: (event) => finish(event, true),
      onPointerCancel: (event) => finish(event, false),
      onClickCapture: (event) => {
        if (!suppressClickRef.current) return
        event.preventDefault()
        event.stopPropagation()
      },
      onKeyDown: (event) => onKeyDownFor(id, event)
    }
  }

  return { containerRef, getItemProps, announcement, draggingId: dragging?.id ?? null }
}
