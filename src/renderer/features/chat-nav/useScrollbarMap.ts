import * as React from 'react'
import { useChatNavStore, EMPTY_CHAT_NAV } from '@/state/chat-nav-store'
import type { NavMessage } from './messageIndex'
import { resolveMapColors, paintMap, type MapColors } from './scrollbarMapPaint'
import {
  isMapUseful,
  layoutMarks,
  lerpMarks,
  markArea,
  sameMarkSet,
  viewportWindow,
  type MapArea,
  type MapMark,
  type MapSource,
  type ScrollMetrics
} from './scrollbarMapMath'

export const MAP_WIDTH_PX = 8
const THROTTLE_MS = 100
const TWEEN_MS = 160

export interface MapModel {
  marks: MapMark[]
  area: MapArea
  hasStub: boolean
  hiddenTurnCount: number
  trackHeight: number
  metrics: ScrollMetrics
}

/** Row positions come from the DOM rows (`[data-message-id]`) in one pass per measure, not from
 * `bridge.getMessageTopOffset` per message: one query plus one rect read each is cheaper than a
 * selector lookup per id at thousands of messages, and the rows are the ground truth because
 * `content-visibility` rows settle at their real height only once they render. */
function measureSources(viewport: HTMLElement, kindById: ReadonlyMap<string, NavMessage['kind']>): MapSource[] {
  const viewportTop = viewport.getBoundingClientRect().top
  const scrollTop = viewport.scrollTop
  const sources: MapSource[] = []
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = row.dataset.messageId
    const kind = id === undefined ? undefined : kindById.get(id)
    if (id === undefined || kind === undefined) continue
    const rect = row.getBoundingClientRect()
    sources.push({ id, kind, top: rect.top - viewportTop + scrollTop, height: rect.height })
  }
  return sources.sort((a, b) => a.top - b.top)
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface ScrollbarMapHandles {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  probeRef: React.RefObject<HTMLSpanElement | null>
  visible: boolean
  modelRef: React.RefObject<MapModel | null>
}

/** Measures the rendered message rows and paints the strip. Recomputes on a `ResizeObserver` of
 * the content and viewport, throttled to 100 ms and then one animation frame; scrolling only
 * repaints the viewport window from the cached layout. */
export function useScrollbarMap(sessionId: string, viewport: HTMLElement | null, enabled: boolean): ScrollbarMapHandles {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const probeRef = React.useRef<HTMLSpanElement>(null)
  const modelRef = React.useRef<MapModel | null>(null)
  const [visible, setVisible] = React.useState(false)
  const index = useChatNavStore((state) => (state.bySession[sessionId] ?? EMPTY_CHAT_NAV).index)
  const indexRef = React.useRef(index)
  indexRef.current = index
  const measureRef = React.useRef<() => void>(() => undefined)

  React.useEffect(() => {
    if (!enabled || !viewport) {
      modelRef.current = null
      setVisible(false)
      return
    }
    let colors: MapColors | null = null
    let colorsKey = ''
    let kindById: ReadonlyMap<string, NavMessage['kind']> = new Map()
    let kindSource: readonly NavMessage[] | null = null
    let from: MapMark[] = []
    let tweenStart = 0
    let drawFrame = 0
    let throttleTimer = 0
    let measureFrame = 0
    let lastMeasureAt = 0
    let shown = false

    const draw = () => {
      drawFrame = 0
      const canvas = canvasRef.current
      const probe = probeRef.current
      const model = modelRef.current
      if (!canvas || !probe || !model) return
      const key = document.documentElement.className
      if (!colors || key !== colorsKey) {
        colors = resolveMapColors(probe)
        colorsKey = key
      }
      const progress = tweenStart === 0 ? 1 : Math.min(1, (performance.now() - tweenStart) / TWEEN_MS)
      const marks = progress < 1 && sameMarkSet(from, model.marks) ? lerpMarks(from, model.marks, progress) : model.marks
      const metrics = { scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight }
      model.metrics = metrics
      paintMap({
        canvas,
        cssWidth: MAP_WIDTH_PX,
        cssHeight: model.trackHeight,
        dpr: window.devicePixelRatio || 1,
        colors,
        marks,
        window: viewportWindow(metrics, model.area),
        stub: model.hasStub
      })
      if (progress < 1) requestDraw()
    }
    const requestDraw = () => {
      if (drawFrame === 0) drawFrame = requestAnimationFrame(draw)
    }

    const measure = () => {
      measureFrame = 0
      lastMeasureAt = performance.now()
      if (kindSource !== indexRef.current) {
        kindSource = indexRef.current
        kindById = new Map(kindSource.map((message) => [message.id, message.kind]))
      }
      const sources = measureSources(viewport, kindById)
      const bridge = useChatNavStore.getState().bySession[sessionId]?.bridge
      const hiddenTurnCount = bridge?.getHiddenTurnCount() ?? 0
      const metrics = { scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight }
      const useful = isMapUseful(metrics.scrollHeight, metrics.clientHeight, sources.length)
      if (useful !== shown) {
        shown = useful
        setVisible(useful)
      }
      if (!useful) {
        modelRef.current = null
        return
      }
      const hasStub = hiddenTurnCount > 0
      const area = markArea(metrics.clientHeight, hasStub)
      const marks = layoutMarks(sources, metrics.scrollHeight, area)
      const previous = modelRef.current
      const animate = previous !== null && !prefersReducedMotion() && sameMarkSet(previous.marks, marks)
      from = animate ? previous.marks : []
      tweenStart = animate ? performance.now() : 0
      modelRef.current = { marks, area, hasStub, hiddenTurnCount, trackHeight: metrics.clientHeight, metrics }
      requestDraw()
    }

    const scheduleMeasure = () => {
      if (throttleTimer !== 0 || measureFrame !== 0) return
      const wait = Math.max(0, THROTTLE_MS - (performance.now() - lastMeasureAt))
      throttleTimer = window.setTimeout(() => {
        throttleTimer = 0
        measureFrame = requestAnimationFrame(measure)
      }, wait)
    }
    measureRef.current = scheduleMeasure

    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(viewport)
    const content = viewport.querySelector('[data-slot="message-scroller-content"]')
    if (content) observer.observe(content)
    viewport.addEventListener('scroll', requestDraw, { passive: true })
    // Theme and High Contrast changes arrive as a root class or data-theme change; recolour even when idle.
    const themeObserver = new MutationObserver(() => {
      colors = null
      requestDraw()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    const forcedColors = typeof matchMedia === 'function' ? matchMedia('(forced-colors: active)') : null
    const onForcedColorsChange = () => {
      colors = null
      requestDraw()
    }
    forcedColors?.addEventListener('change', onForcedColorsChange)
    scheduleMeasure()
    return () => {
      observer.disconnect()
      themeObserver.disconnect()
      forcedColors?.removeEventListener('change', onForcedColorsChange)
      viewport.removeEventListener('scroll', requestDraw)
      window.clearTimeout(throttleTimer)
      cancelAnimationFrame(measureFrame)
      cancelAnimationFrame(drawFrame)
      measureRef.current = () => undefined
      modelRef.current = null
    }
  }, [sessionId, viewport, enabled])

  React.useEffect(() => measureRef.current(), [index])

  return { canvasRef, probeRef, visible, modelRef }
}
