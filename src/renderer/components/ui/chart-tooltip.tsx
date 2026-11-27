// Hover and keyboard tooltips for the shared charts (#1882, ADR 0003). Each chart is one tab stop:
// the arrow keys step the cursor and the same entry the pointer shows is announced through a polite
// status line, because focus stays on the chart and so never reaches the tooltip itself.
import { useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The one tab stop of a chart: the focus ring shows on the plot that the arrow keys drive. */
export const CHART_PLOT_CLASS = 'rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-focus-glow'

export interface ChartTooltipLine {
  /** Empty for a single-value entry, which reads as just the value. */
  label: string
  value: string
  /** The total line of a stacked column. */
  strong?: boolean
}

export interface ChartTooltipEntry {
  heading: string
  lines: ChartTooltipLine[]
}

/** `column` splits the plot into equal slots; `point` snaps to the nearest of evenly spaced points; `row` is driven per row by the caller. */
export type CursorMode = 'column' | 'point' | 'row'

export const chartTooltipText = (entry: ChartTooltipEntry): string =>
  `${entry.heading}: ${entry.lines.map((line) => (line.label ? `${line.label} ${line.value}` : line.value)).join(', ')}`

const clamp = (n: number, count: number): number => Math.max(0, Math.min(count - 1, n))

/** The slot or point under a pointer, from its 0..1 position along the plot. */
export function pointerIndex(fraction: number, count: number, mode: Exclude<CursorMode, 'row'>): number {
  if (count <= 0) return 0
  return mode === 'column' ? clamp(Math.floor(fraction * count), count) : clamp(Math.round(fraction * (count - 1)), count)
}

/** Where a key moves the cursor: a new index, `null` to clear it, or `undefined` when the key is not ours. */
export function cursorAfterKey(current: number | null, key: string, count: number): number | null | undefined {
  if (count <= 0) return undefined
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return current === null ? 0 : clamp(current + 1, count)
    case 'ArrowLeft':
    case 'ArrowUp':
      return current === null ? count - 1 : clamp(current - 1, count)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    case 'Escape':
      return null
    default:
      return undefined
  }
}

interface Cursor {
  index: number | null
  keyboard: boolean
}

export function useChartCursor(count: number, mode: CursorMode) {
  const [cursor, setCursor] = useState<Cursor>({ index: null, keyboard: false })
  const active = cursor.index !== null && cursor.index < count ? cursor.index : null
  const clear = () => setCursor({ index: null, keyboard: false })
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const next = cursorAfterKey(active, event.key, count)
    if (next === undefined) return
    event.preventDefault()
    setCursor({ index: next, keyboard: true })
  }
  const plotProps = {
    tabIndex: 0,
    onKeyDown,
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (active === null && event.currentTarget.matches(':focus-visible')) setCursor({ index: 0, keyboard: true })
    },
    onBlur: clear,
    onPointerLeave: () => setCursor((c) => (c.keyboard ? c : { index: null, keyboard: false })),
    ...(mode === 'row'
      ? {}
      : {
          onPointerMove: (event: PointerEvent<HTMLElement>) => {
            const rect = event.currentTarget.getBoundingClientRect()
            if (rect.width <= 0) return
            setCursor({ index: pointerIndex((event.clientX - rect.left) / rect.width, count, mode), keyboard: false })
          }
        })
  }
  const rowProps = (index: number) => ({ onPointerEnter: () => setCursor({ index, keyboard: false }) })
  return { active, announcement: cursor.keyboard, plotProps, rowProps }
}

/** The tooltip's content: the heading, then one line per value. */
export function ChartTooltipBody({ entry }: { entry: ChartTooltipEntry }) {
  return (
    <div className="flex flex-col gap-1 py-1">
      <span className="font-medium">{entry.heading}</span>
      {entry.lines.map((line, i) => (
        <span key={i} className={cn('flex gap-4 tabular-nums', line.strong && 'border-t border-tooltip-border pt-1 font-medium')}>
          {line.label && <span>{line.label}</span>}
          <span className="ml-auto">{line.value}</span>
        </span>
      ))}
    </div>
  )
}

interface ChartTooltipProps {
  entry: ChartTooltipEntry
  /** Places the anchor inside the chart's `relative` plot; it is also what draws the column or row highlight. */
  anchorClassName?: string
  anchorStyle?: CSSProperties
  children?: ReactNode
}

/** Always open while mounted: the caller mounts it, keyed by the active index, only while a column, point or row is active. */
export function ChartTooltip({ entry, anchorClassName, anchorStyle, children }: ChartTooltipProps) {
  return (
    <Tooltip open>
      <TooltipTrigger asChild>
        <span aria-hidden tabIndex={-1} className={cn('pointer-events-none absolute', anchorClassName)} style={anchorStyle}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="items-start px-4">
        <ChartTooltipBody entry={entry} />
      </TooltipContent>
    </Tooltip>
  )
}

/** Screen readers hear the entry when the keyboard moves the cursor; hover stays silent. */
export function ChartAnnouncement({ entry, enabled }: { entry: ChartTooltipEntry | null; enabled: boolean }) {
  return (
    <p role="status" className="sr-only">
      {enabled && entry ? chartTooltipText(entry) : ''}
    </p>
  )
}
