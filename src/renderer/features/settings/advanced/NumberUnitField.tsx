// A short whole-number field with a unit suffix and thousands separators (Settings > Advanced).
// Commits on Enter or blur; an invalid draft shows the format hint as its validation error and is
// not saved. The unit is part of the accessible name.
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

export function formatCount(n: number): string {
  return n.toLocaleString('en-GB')
}

function parseCount(text: string): number | undefined {
  const cleaned = text.replace(/[,\s]/g, '')
  return /^\d+$/.test(cleaned) ? Number(cleaned) : undefined
}

interface NumberUnitFieldProps {
  id: string
  value: number
  unit: string
  /** Id of the element naming the field; omit with `ariaLabel` inside a table row. */
  labelId?: string
  ariaLabel?: string
  describedBy?: string
  disabled?: boolean
  onCommit: (value: number) => Promise<boolean>
}

export function NumberUnitField({ id, value, unit, labelId, ariaLabel, describedBy, disabled, onCommit }: NumberUnitFieldProps) {
  const text = formatCount(value)
  const [draft, setDraft] = useState(text)
  const [saveFailed, setSaveFailed] = useState(false)
  const saving = useRef(false)
  const errorId = `${id}-error`
  const unitId = `${id}-unit`
  const invalid = parseCount(draft) === undefined

  useEffect(() => {
    setDraft(text)
    setSaveFailed(false)
  }, [text])

  const commit = (): void => {
    const parsed = parseCount(draft)
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
        <Input
          id={id}
          inputMode="numeric"
          className="w-28 text-right"
          disabled={disabled}
          aria-label={labelId || !ariaLabel ? undefined : `${ariaLabel} (${unit})`}
          aria-labelledby={labelId ? `${labelId} ${unitId}` : undefined}
          aria-describedby={[describedBy, showError ? errorId : undefined].filter(Boolean).join(' ') || undefined}
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
          {unit}
        </span>
      </div>
      {showError && (
        <span id={errorId} className="text-xs text-destructive">
          {invalid ? 'Enter a whole number, 0 or more, for example 1,000.' : 'Could not save this value. Try again.'}
        </span>
      )}
    </div>
  )
}
