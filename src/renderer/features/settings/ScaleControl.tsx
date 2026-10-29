// Spec 035 (#842): one Text size row (App, Chat or Code): a slider and a number field kept in step
// (the number field is the non-drag alternative, WCAG 2.5.7), a per-role Reset, and a preview
// sentence in the role's own font at the chosen size.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { SettingRow } from '@/components/settings/SettingRow'
import { cn } from '@/lib/utils'
import { TYPOGRAPHY_MAX_SCALE, TYPOGRAPHY_MIN_SCALE, scaledBodyPx } from '../../../shared/typography'

export const MIN_PERCENT = Math.round(TYPOGRAPHY_MIN_SCALE * 100)
export const MAX_PERCENT = Math.round(TYPOGRAPHY_MAX_SCALE * 100)
const STEP_PERCENT = 5

export function scaleToPercent(scale: number): number {
  return Math.round(scale * 100)
}

/** The rounded body size the percentage gives (the 14px body step, never under the 11px floor). */
export function percentToPx(percent: number): number {
  return Math.round(scaledBodyPx(percent / 100))
}

function snapPercent(value: number): number {
  const snapped = Math.round(value / STEP_PERCENT) * STEP_PERCENT
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, snapped))
}

interface ScaleControlProps {
  /** Short role name: App, Chat or Code. */
  role: string
  id: string
  description: string
  scale: number
  onScaleChange: (scale: number) => void
  /** Tailwind font family class for the preview (the role's own font). */
  fontClass: string
  preview: string
}

export function ScaleControl({ role, id, description, scale, onScaleChange, fontClass, preview }: ScaleControlProps) {
  const percent = scaleToPercent(scale)
  const [draft, setDraft] = useState(String(percent))
  const inputRef = useRef<HTMLInputElement>(null)
  // Re-sync from the store (slider, presets, Reset) but never overwrite what the user is typing.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(String(percent))
  }, [percent])

  function commitDraft() {
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(percent))
      return
    }
    const next = snapPercent(parsed)
    setDraft(String(next))
    onScaleChange(next / 100)
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') commitDraft()
  }

  const atDefault = percent === 100
  return (
    <SettingRow
      id={id}
      label={role}
      labelAsText
      description={description}
      note={
        <p
          className={cn('mt-1 text-foreground', fontClass)}
          style={{ fontSize: `${scaledBodyPx(scale)}px` }}
          aria-hidden
        >
          {preview}
        </p>
      }
    >
      <div className="flex items-center gap-2">
        <Slider
          value={percent}
          onValueChange={(next) => onScaleChange(snapPercent(next) / 100)}
          min={MIN_PERCENT}
          max={MAX_PERCENT}
          step={STEP_PERCENT}
          aria-label={`${role} text size`}
          aria-describedby={`${id}-description`}
          aria-valuetext={`${percent} percent, about ${percentToPx(percent)} px`}
          className="w-40"
        />
        <div className="flex items-center gap-1">
          <Input
            ref={inputRef}
            inputMode="numeric"
            min={MIN_PERCENT}
            max={MAX_PERCENT}
            step={STEP_PERCENT}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={handleDraftKeyDown}
            aria-label={`${role} text size in percent`}
            className="w-16"
          />
          <span aria-hidden className="text-muted-foreground">%</span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Reset ${role} text size`}
          aria-disabled={atDefault || undefined}
          className={cn(atDefault && 'opacity-50')}
          onClick={() => {
            if (!atDefault) onScaleChange(1)
          }}
        >
          Reset
        </Button>
      </div>
    </SettingRow>
  )
}
