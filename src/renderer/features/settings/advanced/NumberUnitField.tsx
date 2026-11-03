// A short whole-number field with a unit suffix (Settings > Advanced), built on the shared
// NumberField. Commits on Enter or blur; an invalid draft shows the format hint as its validation
// error and is not saved. The unit is part of the accessible name, spoken as "percent" for `%`;
// `hint` is an optional secondary line tied to the input with `aria-describedby`.
// The spinners and arrow keys step by 1000 for tokens (large counts) and by 1 for everything else.
import { useEffect, useRef, useState } from 'react'
import { NumberField } from '@/components/ui/NumberField'

export function formatCount(n: number): string {
  return n.toLocaleString('en-GB')
}

/** Hint shown wherever a context window is needed but unknown (idle field and per-model rows). */
export const WINDOW_UNKNOWN_HINT = 'Context window unknown; the percent cannot be converted to tokens.'

function parseCount(text: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(text)) return undefined
  const n = Number(text)
  return n >= min && n <= max ? n : undefined
}

interface NumberUnitFieldProps {
  id: string
  value: number
  unit: string
  /** Inclusive bounds; the error names them when `max` is set. */
  min?: number
  max?: number
  /** Secondary line under the field, such as "≈ 140,000 tokens". */
  hint?: string
  /** Id of the element naming the field; omit with `ariaLabel` inside a table row. */
  labelId?: string
  ariaLabel?: string
  describedBy?: string
  disabled?: boolean
  onCommit: (value: number) => Promise<boolean>
}

export function NumberUnitField({ id, value, unit, min = 0, max = Number.MAX_SAFE_INTEGER, hint, labelId, ariaLabel, describedBy, disabled, onCommit }: NumberUnitFieldProps) {
  const text = String(value)
  const [draft, setDraft] = useState(text)
  const [saveFailed, setSaveFailed] = useState(false)
  const saving = useRef(false)
  const errorId = `${id}-error`
  const unitId = `${id}-unit`
  const hintId = `${id}-hint`
  const spokenUnit = unit === '%' ? 'percent' : unit
  const invalid = parseCount(draft, min, max) === undefined

  useEffect(() => {
    setDraft(text)
    setSaveFailed(false)
  }, [text])

  const commit = (): void => {
    const parsed = parseCount(draft, min, max)
    if (parsed === undefined || parsed === value || saving.current) return
    saving.current = true
    void onCommit(parsed)
      .then((ok) => setSaveFailed(!ok))
      .catch(() => setSaveFailed(true))
      .finally(() => {
        saving.current = false
      })
  }

  const showError = invalid || saveFailed
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <NumberField
          id={id}
          className="w-28 text-right"
          min={min}
          max={max < Number.MAX_SAFE_INTEGER ? max : undefined}
          step={unit === 'tokens' ? 1000 : 1}
          disabled={disabled}
          aria-label={labelId || !ariaLabel ? undefined : `${ariaLabel} (${spokenUnit})`}
          aria-labelledby={labelId ? `${labelId} ${unitId}` : undefined}
          aria-describedby={[describedBy, hint ? hintId : undefined, showError ? errorId : undefined].filter(Boolean).join(' ') || undefined}
          aria-invalid={invalid}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setSaveFailed(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
          onBlur={commit}
        />
        <span id={unitId} className="text-xs text-muted-foreground">
          {unit === '%' ? (
            <>
              <span aria-hidden>%</span>
              <span className="sr-only">percent</span>
            </>
          ) : (
            unit
          )}
        </span>
      </div>
      {hint && (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
      {showError && (
        <span id={errorId} role="alert" className="text-xs text-destructive">
          {invalid ? (max < Number.MAX_SAFE_INTEGER ? `Enter a whole number from ${min} to ${max}.` : 'Enter a whole number, 0 or more, for example 1000.') : 'Could not save this value. Try again.'}
        </span>
      )}
    </div>
  )
}
