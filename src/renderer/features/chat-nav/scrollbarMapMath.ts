import type { NavMessageKind } from './messageIndex'

export const MIN_MARK_PX = 2
export const MERGE_GAP_PX = 1
export const HIT_TOLERANCE_PX = 6
export const MIN_VIEWPORT_WINDOW_PX = 4
/** The map shows only when the content is taller than this many viewports. */
export const MIN_CONTENT_VIEWPORTS = 1.5
/** Height reserved at the top of the track for the "N earlier turns" stub, plus a gap under it. */
export const STUB_PX = 10
export const STUB_GAP_PX = 2

/** One rendered navigable row, measured in content pixels from the top of the scrollable content. */
export interface MapSource {
  id: string
  kind: NavMessageKind
  top: number
  height: number
}

/** One drawn mark in track pixels. A merged mark stands for `count` messages; `id` is the first. */
export interface MapMark {
  id: string
  kind: NavMessageKind
  y: number
  h: number
  count: number
}

export interface MapArea {
  top: number
  height: number
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function isMapUseful(scrollHeight: number, clientHeight: number, sourceCount: number): boolean {
  return sourceCount > 0 && clientHeight > 0 && scrollHeight > clientHeight * MIN_CONTENT_VIEWPORTS
}

/** The part of the track the content maps onto: all of it, or what is left under the stub. */
export function markArea(trackHeight: number, hasStub: boolean): MapArea {
  const top = hasStub ? STUB_PX + STUB_GAP_PX : 0
  return { top, height: Math.max(1, trackHeight - top) }
}

/** Marks for the sources, at `top / scrollHeight` of the area and at least `MIN_MARK_PX` tall.
 * Within each kind's half of the strip, marks closer than `MERGE_GAP_PX` merge into one. Returned
 * sorted by centre, which is what `hitTestMark` searches. */
export function layoutMarks(sources: readonly MapSource[], scrollHeight: number, area: MapArea): MapMark[] {
  if (scrollHeight <= 0) return []
  const scale = area.height / scrollHeight
  const open: Record<NavMessageKind, MapMark | null> = { user: null, agent: null }
  const marks: MapMark[] = []
  for (const source of sources) {
    const y = area.top + source.top * scale
    const h = Math.max(MIN_MARK_PX, source.height * scale)
    const current = open[source.kind]
    if (current && y - (current.y + current.h) < MERGE_GAP_PX) {
      current.h = Math.max(current.h, y + h - current.y)
      current.count += 1
      continue
    }
    const mark: MapMark = { id: source.id, kind: source.kind, y, h, count: 1 }
    open[source.kind] = mark
    marks.push(mark)
  }
  return marks.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))
}

function distanceToMark(mark: MapMark, y: number): number {
  if (y < mark.y) return mark.y - y
  return y > mark.y + mark.h ? y - (mark.y + mark.h) : 0
}

/** The mark nearest `y` within `tolerance`, found by binary search on the centre-sorted list;
 * `null` when none is close enough. */
export function hitTestMark(marks: readonly MapMark[], y: number, tolerance = HIT_TOLERANCE_PX): MapMark | null {
  let low = 0
  let high = marks.length
  while (low < high) {
    const middle = (low + high) >> 1
    const mark = marks[middle]!
    if (mark.y + mark.h / 2 < y) low = middle + 1
    else high = middle
  }
  // Centre order is not extent order, so a few neighbours on each side can be nearer by edge.
  let best: MapMark | null = null
  let bestDistance = tolerance + 1
  for (let i = Math.max(0, low - 3); i < Math.min(marks.length, low + 3); i += 1) {
    const distance = distanceToMark(marks[i]!, y)
    if (distance < bestDistance) {
      best = marks[i]!
      bestDistance = distance
    }
  }
  return best
}

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** The faint viewport rectangle in track pixels. */
export function viewportWindow(metrics: ScrollMetrics, area: MapArea): { y: number; h: number } {
  if (metrics.scrollHeight <= 0) return { y: area.top, h: 0 }
  const scale = area.height / metrics.scrollHeight
  const h = clamp(metrics.clientHeight * scale, MIN_VIEWPORT_WINDOW_PX, area.height)
  return { y: clamp(area.top + metrics.scrollTop * scale, area.top, area.top + area.height - h), h }
}

/** The `scrollTop` that centres the viewport on the track position `y`, clamped to the content. */
export function pointerToScrollTop(y: number, metrics: ScrollMetrics, area: MapArea): number {
  const fraction = clamp((y - area.top) / area.height, 0, 1)
  return clamp(fraction * metrics.scrollHeight - metrics.clientHeight / 2, 0, metrics.scrollHeight - metrics.clientHeight)
}

/** Whether two layouts mark the same messages, so a move between them can be animated. */
export function sameMarkSet(a: readonly MapMark[], b: readonly MapMark[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || a[i]!.kind !== b[i]!.kind) return false
  }
  return true
}

/** The marks `progress` (0..1) of the way from `from` to `to`; both must be a `sameMarkSet`. */
export function lerpMarks(from: readonly MapMark[], to: readonly MapMark[], progress: number): MapMark[] {
  return to.map((mark, i) => {
    const start = from[i]!
    return { ...mark, y: start.y + (mark.y - start.y) * progress, h: start.h + (mark.h - start.h) * progress }
  })
}
