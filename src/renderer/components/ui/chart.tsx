// The shared chart primitive (spec 060 S2-01, ADR 0003): hand-written SVG, no charting library.
// Three shapes: a stacked column chart (`StackedBarChart`), a labelled horizontal bar list
// (`BarChart`) and a `Sparkline`. WCAG 1.4.1 and 1.4.11: every series gets a fill PATTERN as well
// as a theme chart colour, a 1px foreground outline, and a direct label with its total in the
// legend, so no series relies on colour alone. Each chart has a "View as table" toggle that swaps
// the drawing for a real table of the same numbers.
import { Fragment, useId, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { SortableTable, sortRowsBy } from '@/components/SortableTable'
import type { SortableColumn } from '@/components/SortableTable'
import { cn } from '@/lib/utils'

export interface ChartSeries {
  name: string
  /** A neutral, low-key series such as "Other": drawn in the muted token, never a status hue. */
  muted?: boolean
}

// Each hue is mixed toward the foreground so the fill stays at 3:1 or better against the card in
// every theme; the 1px foreground outline on each shape carries the 1.4.11 boundary as well.
const SERIES_COLOURS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'].map(
  (c) => `color-mix(in oklab, ${c} 78%, var(--foreground))`
)
const MUTED_COLOUR = 'var(--muted-foreground)'
const PATTERN_COUNT = 5

const seriesColours = (series: ChartSeries[]): string[] =>
  series.map((s, i) => (s.muted ? MUTED_COLOUR : (SERIES_COLOURS[i % SERIES_COLOURS.length] ?? MUTED_COLOUR)))

/**
 * Pattern defs, rendered ONCE per chart in a zero-size svg; the bars and the legend swatches both
 * reference them by id (`url(#prefix-i)` resolves across svgs in one document), so no id repeats.
 */
function SeriesPatterns({ prefix, colours }: { prefix: string; colours: string[] }) {
  const ink = 'var(--foreground)'
  return (
    <svg aria-hidden focusable="false" width="0" height="0" className="absolute">
      <defs>
        {colours.map((colour, i) => {
          const id = `${prefix}-${i}`
          const base = <rect width="6" height="6" fill={colour} />
          return <Fragment key={id}>{renderPattern(id, i, base, ink)}</Fragment>
        })}
      </defs>
    </svg>
  )
}

function renderPattern(id: string, i: number, base: ReactNode, ink: string): ReactNode {
  const common = { id, width: '6', height: '6', patternUnits: 'userSpaceOnUse' } as const
  switch (i % PATTERN_COUNT) {
    case 1:
      return (
        <pattern {...common} patternTransform="rotate(45)">
          {base}
          <rect width="2" height="6" fill={ink} fillOpacity="0.55" />
        </pattern>
      )
    case 2:
      return (
        <pattern {...common}>
          {base}
          <circle cx="3" cy="3" r="1.2" fill={ink} fillOpacity="0.6" />
        </pattern>
      )
    case 3:
      return (
        <pattern {...common}>
          {base}
          <rect width="6" height="2" fill={ink} fillOpacity="0.55" />
        </pattern>
      )
    case 4:
      return (
        <pattern {...common}>
          {base}
          <path d="M0 0L6 6M6 0L0 6" stroke={ink} strokeOpacity="0.55" strokeWidth="1" />
        </pattern>
      )
    default:
      return <pattern {...common}>{base}</pattern>
  }
}

/** The legend swatch: the same pattern as the bars, so the key matches the drawing. */
function Swatch({ prefix, index }: { prefix: string; index: number }) {
  return (
    <svg aria-hidden width="14" height="14" className="shrink-0">
      <rect width="14" height="14" fill={`url(#${prefix}-${index})`} stroke="var(--foreground)" strokeWidth="1" />
    </svg>
  )
}

/** The "View as table" state of one chart, owned by the screen so the button can live in the section's `actions`. */
export interface ChartView {
  asTable: boolean
  tableId: string
  toggle: ReactNode
}

export function useChartView(): ChartView {
  const [asTable, setAsTable] = useState(false)
  const tableId = useId()
  const toggle = (
    <Button type="button" variant="ghost" size="sm" aria-pressed={asTable} aria-controls={tableId} onClick={() => setAsTable((value) => !value)}>
      View as table
    </Button>
  )
  return { asTable, tableId, toggle }
}

interface ChartFrameProps {
  view: ChartView
  /** One sentence for screen readers: what the chart shows. */
  summary: string
  /** Renders the same data as a table. */
  table: ReactNode
  legend?: ReactNode
  patterns: ReactNode
  children: ReactNode
  className?: string
}

function ChartFrame({ view, summary, table, legend, patterns, children, className }: ChartFrameProps) {
  return (
    <div className={cn('min-w-0', className)}>
      {patterns}
      <div id={view.tableId}>
        {view.asTable ? (
          table
        ) : (
          <>
            <p className="sr-only">{summary}</p>
            {children}
            {legend && <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{legend}</ul>}
          </>
        )}
      </div>
    </div>
  )
}

interface ChartTableRow {
  id: string
  cells: string[]
  /** What each column sorts by; the first column sorts by original order. */
  sortBy: (number | string)[]
}

function ChartTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: ChartTableRow[] }) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'c0', dir: 'asc' })
  const columns: SortableColumn<ChartTableRow>[] = headers.map((header, i) => ({
    key: `c${i}`,
    header,
    align: i === 0 ? 'left' : 'right',
    sortValue: (row) => row.sortBy[i] ?? 0,
    render: (row) => row.cells[i] ?? ''
  }))
  return (
    <div className="max-h-64 overflow-auto">
      <SortableTable
        caption={caption}
        columns={columns}
        rows={sortRowsBy(rows, columns, sort)}
        rowKey={(row) => row.id}
        sort={sort}
        onSortChange={setSort}
        emptyText="No data in this range."
      />
    </div>
  )
}

export interface StackedBarChartProps {
  /** Names the table view's caption. */
  title: string
  summary: string
  view: ChartView
  series: ChartSeries[]
  /** One column per bucket; `values[i]` belongs to `series[i]`. */
  buckets: { label: string; values: number[] }[]
  formatValue(value: number): string
  /** Heading of the bucket column in the table view, for example "Day". */
  bucketHeader: string
}

const CHART_HEIGHT = 140
const CHART_WIDTH = 600

export function StackedBarChart({ title, summary, view, series, buckets, formatValue, bucketHeader }: StackedBarChartProps) {
  const prefix = useId().replace(/:/g, '')
  const totals = buckets.map((bucket) => bucket.values.reduce((sum, v) => sum + v, 0))
  const max = Math.max(0, ...totals)
  const slot = buckets.length > 0 ? CHART_WIDTH / buckets.length : CHART_WIDTH
  const barWidth = Math.max(2, slot * 0.7)
  const seriesTotals = series.map((_, i) => buckets.reduce((sum, bucket) => sum + (bucket.values[i] ?? 0), 0))
  return (
    <ChartFrame
      view={view}
      summary={summary}
      patterns={<SeriesPatterns prefix={prefix} colours={seriesColours(series)} />}
      legend={series.map((s, i) => (
        <li key={s.name} className="flex items-center gap-2">
          <Swatch prefix={prefix} index={i} />
          <span className="truncate">{s.name}</span>
          <span className="tabular-nums text-muted-foreground">{formatValue(seriesTotals[i] ?? 0)}</span>
        </li>
      ))}
      table={
        <ChartTable
          caption={`${title} as a table`}
          headers={[bucketHeader, ...series.map((s) => s.name), 'Total']}
          rows={buckets.map((bucket, i) => ({
            id: String(i),
            cells: [bucket.label, ...bucket.values.map(formatValue), formatValue(totals[i] ?? 0)],
            sortBy: [i, ...bucket.values, totals[i] ?? 0]
          }))}
        />
      }
    >
      <div className="flex gap-2">
        <div aria-hidden className="flex flex-col justify-between text-xs tabular-nums text-muted-foreground">
          <span>{formatValue(max)}</span>
          <span>{formatValue(0)}</span>
        </div>
        <svg
          aria-hidden
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-36 min-w-0 flex-1 border-b border-l border-divider"
        >
          {buckets.map((bucket, bi) => {
            let y = CHART_HEIGHT
            return (
              <g key={bi}>
                {bucket.values.map((value, si) => {
                  const height = max > 0 ? (value / max) * (CHART_HEIGHT - 2) : 0
                  if (height <= 0) return null
                  y -= height
                  return (
                    <rect
                      key={series[si]?.name ?? si}
                      x={bi * slot + (slot - barWidth) / 2}
                      y={y}
                      width={barWidth}
                      height={height}
                      fill={`url(#${prefix}-${si})`}
                      stroke="var(--foreground)"
                      strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>
      {buckets.length > 0 && (
        <div aria-hidden className="flex justify-between pl-10 text-xs text-muted-foreground">
          <span>{buckets[0]?.label}</span>
          <span>{buckets[buckets.length - 1]?.label}</span>
        </div>
      )}
    </ChartFrame>
  )
}

export interface BarChartProps {
  /** Names the table view's caption. */
  title: string
  summary: string
  view: ChartView
  rows: { label: string; value: number; detail?: string }[]
  formatValue(value: number): string
  /** Heading of the label column in the table view, for example "Token type". */
  labelHeader: string
  /** Heading of the detail column in the table view, when rows carry `detail`. */
  detailHeader?: string
}

export function BarChart({ title, summary, view, rows, formatValue, labelHeader, detailHeader }: BarChartProps) {
  const prefix = useId().replace(/:/g, '')
  const max = Math.max(0, ...rows.map((row) => row.value))
  const hasDetail = rows.some((row) => row.detail !== undefined)
  return (
    <ChartFrame
      view={view}
      summary={summary}
      patterns={<SeriesPatterns prefix={prefix} colours={seriesColours(rows.map((row) => ({ name: row.label })))} />}
      table={
        <ChartTable
          caption={`${title} as a table`}
          headers={[labelHeader, 'Amount', ...(hasDetail ? [detailHeader ?? 'Detail'] : [])]}
          rows={rows.map((row, i) => ({
            id: String(i),
            cells: [row.label, formatValue(row.value), ...(hasDetail ? [row.detail ?? ''] : [])],
            sortBy: [i, row.value, ...(hasDetail ? [row.detail ?? ''] : [])]
          }))}
        />
      }
    >
      <ul className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <li key={row.label} className="flex flex-col gap-1 text-xs">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{row.label}</span>
              <span className="ml-auto tabular-nums">{formatValue(row.value)}</span>
              {row.detail !== undefined && <span className="tabular-nums text-muted-foreground">{row.detail}</span>}
            </div>
            <svg aria-hidden className="h-3 w-full" preserveAspectRatio="none" viewBox="0 0 100 12">
              <rect
                width={max > 0 ? Math.max(0.5, (row.value / max) * 100) : 0}
                height="12"
                fill={`url(#${prefix}-${i})`}
                stroke="var(--foreground)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </li>
        ))}
      </ul>
    </ChartFrame>
  )
}

export interface SparklineProps {
  /** Reads as the chart's accessible name, for example "Mood over the last 30 days". */
  label: string
  values: number[]
  className?: string
}

export function Sparkline({ label, values, className }: SparklineProps) {
  const max = Math.max(1e-9, ...values)
  const step = values.length > 1 ? 100 / (values.length - 1) : 0
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(28 - (v / max) * 26).toFixed(2)}`).join(' ')
  const last = values.length > 0 ? points.split(' ')[values.length - 1]?.split(',') : null
  return (
    <svg role="img" aria-label={label} viewBox="0 0 100 30" preserveAspectRatio="none" className={cn('h-8 w-full', className)}>
      <polyline points={points} fill="none" stroke="var(--foreground)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0]} cy={last[1]} r="2" fill="var(--foreground)" />}
    </svg>
  )
}
