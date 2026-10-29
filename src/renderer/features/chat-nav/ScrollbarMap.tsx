import * as React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSettingsStore } from '@/state'
import { EMPTY_CHAT_NAV, useChatNavStore } from '@/state/chat-nav-store'
import { jumpToMessage } from './jumpToMessage'
import { hitTestMark, pointerToScrollTop, STUB_PX } from './scrollbarMapMath'
import { MAP_WIDTH_PX, useScrollbarMap } from './useScrollbarMap'

const HOVER_DELAY_MS = 300
const DRAG_THRESHOLD_PX = 3
const GUTTER_GAP_PX = 2

interface TooltipState {
  y: number
  lines: string[]
}

/** The viewport's `onWheel` marks a real scroll gesture, which is what lets the transcript detach
 * from autoscroll when the position moves up; a synthetic wheel event gives a map drag the same
 * standing as a drag on the native scrollbar. */
function markScrollGesture(viewport: HTMLElement): void {
  viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** A VS Code style overview strip in the scrollbar gutter, beside the native scrollbar: one mark per
 * rendered user message (left half) and agent message (right half), the visible range as a faint
 * window, click to jump, drag to scroll. A pointer convenience only: `aria-hidden` and not
 * focusable, because Previous/Next message, the Outline and Find cover every keyboard route.
 * Render inside the transcript's `MessageScroller` root. */
export function ScrollbarMap({ sessionId }: { sessionId: string }) {
  const enabled = useSettingsStore((state) => state.settings.showScrollbarMap !== false)
  const anchorRef = React.useRef<HTMLSpanElement>(null)
  const [viewport, setViewport] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => {
    setViewport(anchorRef.current?.parentElement?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]') ?? null)
  }, [])
  return (
    <>
      <span ref={anchorRef} hidden />
      {enabled && viewport && <MapStrip sessionId={sessionId} viewport={viewport} />}
    </>
  )
}

function MapStrip({ sessionId, viewport }: { sessionId: string; viewport: HTMLElement }) {
  const { canvasRef, probeRef, visible, modelRef } = useScrollbarMap(sessionId, viewport, true)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null)
  const gesture = React.useRef<{ startY: number; dragging: boolean } | null>(null)
  const hoverTimer = React.useRef(0)
  const hoverKey = React.useRef('')
  const [gutter, setGutter] = React.useState(0)

  // The native scrollbar's width (0 for an overlay scrollbar): the strip sits just inside it.
  React.useEffect(() => {
    const update = () => setGutter(viewport.offsetWidth - viewport.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [viewport])

  React.useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const trackY = (event: React.PointerEvent): number => event.clientY - (wrapperRef.current?.getBoundingClientRect().top ?? 0)

  const scrollToPointer = (y: number) => {
    const model = modelRef.current
    if (!model) return
    markScrollGesture(viewport)
    const metrics = { scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight }
    viewport.scrollTop = pointerToScrollTop(y, metrics, model.area)
  }

  const hideTooltip = () => {
    window.clearTimeout(hoverTimer.current)
    hoverKey.current = ''
    setTooltip(null)
  }

  const showTooltipSoon = (y: number) => {
    const model = modelRef.current
    if (!model) return
    const inStub = model.hasStub && y < STUB_PX
    const mark = inStub ? null : hitTestMark(model.marks, y)
    const key = inStub ? 'stub' : (mark?.id ?? '')
    if (key === hoverKey.current) return
    window.clearTimeout(hoverTimer.current)
    hoverKey.current = key
    setTooltip(null)
    if (key === '') return
    hoverTimer.current = window.setTimeout(() => {
      if (inStub) {
        const n = model.hiddenTurnCount
        setTooltip({ y, lines: [`${n} earlier ${n === 1 ? 'turn' : 'turns'}`, 'Click to load'] })
        return
      }
      const message = mark && (useChatNavStore.getState().bySession[sessionId] ?? EMPTY_CHAT_NAV).index.find((m) => m.id === mark.id)
      if (!mark || !message) return
      const role = message.kind === 'user' ? 'You' : 'Agent'
      const header = message.at ? `${role}, ${timeLabel(message.at)}` : role
      const more = mark.count > 1 ? ` (+${mark.count - 1} more)` : ''
      setTooltip({ y: mark.y + mark.h / 2, lines: [`${header}${more}`, message.firstLine] })
    }, HOVER_DELAY_MS)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { startY: event.clientY, dragging: false }
    hideTooltip()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    const y = trackY(event)
    if (!current) {
      showTooltipSoon(y)
      return
    }
    if (!current.dragging && Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD_PX) return
    current.dragging = true
    scrollToPointer(y)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const model = modelRef.current
    if (!current || current.dragging || !model) return
    const y = trackY(event)
    if (model.hasStub && y < STUB_PX) {
      useChatNavStore.getState().bySession[sessionId]?.bridge?.revealEarlier()
      return
    }
    const mark = hitTestMark(model.marks, y)
    if (mark && jumpToMessage(sessionId, mark.id)) return
    scrollToPointer(y)
  }

  return (
    <div
      ref={wrapperRef}
      aria-hidden="true"
      data-slot="scrollbar-map"
      hidden={!visible}
      className="absolute inset-y-0 z-[5] touch-none select-none"
      style={{ width: MAP_WIDTH_PX, insetInlineEnd: gutter + GUTTER_GAP_PX }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        gesture.current = null
      }}
      onPointerLeave={hideTooltip}
    >
      <span ref={probeRef} hidden className="forced-color-adjust-none" />
      <canvas ref={canvasRef} className="block size-full" />
      <Tooltip open={tooltip !== null}>
        <TooltipTrigger asChild>
          <span aria-hidden="true" className="pointer-events-none absolute inset-s-0 size-px" style={{ top: tooltip?.y ?? 0 }} />
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-64 flex-col items-start gap-0">
          <span className="font-medium">{tooltip?.lines[0]}</span>
          {tooltip?.lines[1] && <span className="max-w-full truncate text-muted-foreground">{tooltip.lines[1]}</span>}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
