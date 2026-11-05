// The shared progress strip (spec 060 S2-04, ADR 0003): a labelled `role="progressbar"` with a
// numeric value, plus a polite live region that announces `doneText` once when it completes.
// The label is the visible text; the bar itself is a shape cue (fill over a bordered track).
import { useEffect, useId, useRef, useState } from 'react'

export interface ProgressStripProps {
  value: number
  max: number
  /** Visible line, for example "Counting your sins: 4 of 12 sessions". */
  label: string
  /** Announced (and shown nowhere) when `value` reaches `max` after being below it; omit when a screen owns the announcement. */
  doneText?: string
  /** Fill colour role: ok (default), warning near a limit, error at it. The label must also say so; colour is never the only cue. */
  state?: 'ok' | 'warning' | 'error'
}

const FILL_CLASS = { ok: 'bg-foreground', warning: 'bg-severity-warning', error: 'bg-severity-error' } as const

export function ProgressStrip({ value, max, label, doneText, state = 'ok' }: ProgressStripProps) {
  const labelId = useId()
  const done = max > 0 && value >= max
  const [announce, setAnnounce] = useState('')
  const wasDone = useRef(done)
  useEffect(() => {
    // Only a below-max to max change announces; a bar that first renders full stays silent.
    if (done && !wasDone.current) setAnnounce(doneText ?? '')
    else if (!done) setAnnounce('')
    wasDone.current = done
  }, [done, doneText])
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="flex flex-col gap-1">
      <p id={labelId} className="text-xs text-muted-foreground">
        {label}
      </p>
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={`${percent}%`}
        className="h-2 w-full overflow-hidden rounded-full border border-foreground/60 bg-muted"
      >
        <div className={`h-full ${FILL_CLASS[state]} transition-[width] motion-reduce:transition-none`} style={{ width: `${percent}%` }} />
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>
  )
}
