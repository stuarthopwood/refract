// The shared progress strip (spec 060 S2-04, ADR 0003): a labelled `role="progressbar"` with a
// numeric value, plus a polite live region that announces `doneText` once when it completes.
// The label is the visible text; the bar itself is a shape cue (fill over a bordered track), or,
// with `segments`, a slim h-1 row of aria-hidden blocks beside the label whose state reads by fill, edge and pulse (FR-146, FR-175).
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type ProgressSegmentState = 'done' | 'running' | 'queued'

export interface ProgressStripProps {
  value: number
  max: number
  /** Visible line, for example "Counting your sins: 4 of 12 sessions". */
  label: string
  /** Announced (and shown nowhere) when `value` reaches `max` after being below it; omit when a screen owns the announcement. */
  doneText?: string
  /** Fill colour role: ok (default), warning near a limit, error at it. The label must also say so; colour is never the only cue. */
  state?: 'ok' | 'warning' | 'error'
  /** One block per step instead of the continuous fill; `value` and `max` still drive the progressbar values. */
  segments?: readonly ProgressSegmentState[]
  /** Replaces the default "{percent}%" `aria-valuetext`, for example "2 of 4 stages done". */
  valueText?: string
  className?: string
}

const FILL_CLASS = { ok: 'bg-foreground', warning: 'bg-severity-warning', error: 'bg-severity-error' } as const

// Solid fill, hairline edge and outlined-and-pulsing are three different shapes, so state never rides on colour alone (WCAG 1.4.1).
// The queued edge is `muted-foreground` (3:1 against the card, unlike the `divider` hairline). Forced colours drop the fills, so there
// the same three states read by border: a thick solid block, a thin dashed outline and a medium outline in the highlight colour.
export const SEGMENT_CLASS: Record<ProgressSegmentState, string> = {
  done: 'border border-severity-success bg-severity-success/65 forced-colors:border-4 forced-colors:border-solid forced-colors:border-[CanvasText]',
  queued: 'border border-muted-foreground bg-muted forced-colors:border-dashed forced-colors:border-[CanvasText]',
  running: 'animate-pulse border-2 border-accent-text bg-transparent motion-reduce:animate-none forced-colors:border-solid forced-colors:border-[Highlight]'
}

/** The live region's text after a render: `doneText` on a below-max to max change, empty while unfinished, otherwise unchanged. */
export function nextAnnouncement(done: boolean, wasDone: boolean, doneText: string | undefined, current: string): string {
  if (done && !wasDone) return doneText ?? ''
  return done ? current : ''
}

export function ProgressStrip({ value, max, label, doneText, state = 'ok', segments, valueText, className }: ProgressStripProps) {
  const labelId = useId()
  const done = max > 0 && value >= max
  const [announce, setAnnounce] = useState('')
  const wasDone = useRef(done)
  useEffect(() => {
    // Only a below-max to max change announces; a bar that first renders full stays silent.
    setAnnounce((current) => nextAnnouncement(done, wasDone.current, doneText, current))
    wasDone.current = done
  }, [done, doneText])
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  const bar = (
    <div
      role="progressbar"
      aria-labelledby={labelId}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      aria-valuetext={valueText ?? `${percent}%`}
      className={segments ? 'flex h-1 min-w-0 flex-1 gap-0.5' : 'h-2 w-full overflow-hidden rounded-full border border-foreground/60 bg-muted'}
    >
      {segments ? (
        segments.map((segment, index) => (
          <span key={index} aria-hidden="true" data-segment={segment} className={cn('h-full min-w-1 flex-1 rounded-full', SEGMENT_CLASS[segment])} />
        ))
      ) : (
        <div className={`h-full ${FILL_CLASS[state]} transition-[width] motion-reduce:transition-none`} style={{ width: `${percent}%` }} />
      )}
    </div>
  )
  return (
    // Segmented: the label and the slim bar share one row so the header stays one calm line; the continuous bar keeps the stacked layout.
    <div className={cn(segments ? 'flex items-center gap-2' : 'flex flex-col gap-1', className)}>
      <p id={labelId} className={cn('text-xs text-muted-foreground', segments && 'shrink-0 tabular-nums')}>
        {label}
      </p>
      {bar}
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>
  )
}
