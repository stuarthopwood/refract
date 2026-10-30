// The shared progress strip (spec 060 S2-04, ADR 0003): a labelled `role="progressbar"` with a
// numeric value, plus a polite live region that announces `doneText` once when it completes.
// The label is the visible text; the bar itself is a shape cue (fill over a bordered track).
import { useEffect, useId, useState } from 'react'

export interface ProgressStripProps {
  value: number
  max: number
  /** Visible line, for example "Counting your sins: 4 of 12 sessions". */
  label: string
  /** Announced (and shown nowhere) when `value` reaches `max` after being below it. */
  doneText: string
}

export function ProgressStrip({ value, max, label, doneText }: ProgressStripProps) {
  const labelId = useId()
  const done = max > 0 && value >= max
  const [announce, setAnnounce] = useState('')
  useEffect(() => {
    setAnnounce(done ? doneText : '')
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
        className="h-2 w-full overflow-hidden rounded-full border border-foreground/60 bg-muted"
      >
        <div className="h-full bg-foreground transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>
  )
}
