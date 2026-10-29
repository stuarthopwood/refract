import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { ColorPicker } from '@/components/ColorPicker'
import type { ColorPickerPreset } from '@/components/ColorPicker'
import { PROJECT_PRESETS, adjustForContrast, nearStateColor, parseHex, projectColorCss } from '@/lib/projectColor'
import { useSidebarRgb } from './useSidebarRgb'
import type { ProjectColor, Repository } from '../../../shared/model'

const PRESET_SWATCHES: readonly ColorPickerPreset[] = PROJECT_PRESETS.map((preset, index) => ({
  id: preset.id,
  name: preset.name,
  color: `var(--project-${index + 1})`
}))

// Issue #887: the Project colour popover opened from a Project header's "..." menu. Edits a
// draft only; nothing is saved until Apply, and Esc (or Cancel) leaves the saved colour as it was.
export function ProjectColorPopover({
  repository,
  open,
  onOpenChange,
  onApply,
  returnFocusRef,
  anchorRef,
  onPreviewChange
}: {
  repository: Repository
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Resolves to an error message, or `null` on success (the same contract as `rename`). */
  onApply: (color: ProjectColor | null) => Promise<string | null>
  returnFocusRef: React.RefObject<HTMLElement | null>
  /** The element the popover anchors to (the Project header row). */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Called with the draft colour while open (so the header previews it) and `undefined` once closed. */
  onPreviewChange: (color: ProjectColor | null | undefined) => void
}) {
  const [draft, setDraft] = useState<ProjectColor | null>(repository.color ?? null)
  const [hexText, setHexText] = useState(repository.color?.kind === 'custom' ? repository.color.hex : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [hexTouched, setHexTouched] = useState(false)
  const background = useSidebarRgb()
  const contentRef = useRef<HTMLDivElement>(null)
  const hexId = useId()
  const hexErrorId = `${hexId}-error`

  useEffect(() => {
    if (!open) return
    setDraft(repository.color ?? null)
    setHexText(repository.color?.kind === 'custom' ? repository.color.hex : '')
    setError(null)
    setHexTouched(false)
    // Only a fresh open resets the draft; a saved change while open must not clobber it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    onPreviewChange(open ? draft : undefined)
  }, [open, draft, onPreviewChange])

  const hexInvalid = hexText.trim() !== '' && !parseHex(hexText)
  const hexEmptyCustom = hexText.trim() === '' && draft?.kind === 'custom'
  const changed = JSON.stringify(draft) !== JSON.stringify(repository.color ?? null)
  const canApply = changed && !hexInvalid && !hexEmptyCustom
  const preview = projectColorCss(draft ?? undefined, background)
  const nearState = draft?.kind === 'custom' ? nearStateColor(draft.hex) : null
  const pickerHex = draft?.kind === 'custom' ? draft.hex : parseHex(hexText) ? hexText.trim() : '#7c9cf0'

  function pickCustom(hex: string) {
    setHexText(hex)
    setDraft({ kind: 'custom', hex })
    setError(null)
  }

  function pickPreset(id: string) {
    setDraft({ kind: 'preset', id })
    setHexText('')
    setError(null)
  }

  function resetDraft() {
    setDraft(null)
    setHexText('')
    setError(null)
  }

  function onHexChange(text: string) {
    setHexText(text)
    setError(null)
    if (parseHex(text)) setDraft({ kind: 'custom', hex: text.trim() })
  }

  async function apply(color: ProjectColor | null) {
    if (saving) return
    setSaving(true)
    const message = await onApply(color)
    setSaving(false)
    if (message) setError(message)
    else onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        ref={contentRef}
        align="start"
        aria-label={`Project colour for ${repository.name}`}
        className="flex w-64 flex-col gap-4"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const radios = contentRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')
          const checked = contentRef.current?.querySelector<HTMLElement>('[role="radio"][data-state="checked"]')
          ;(checked ?? radios?.[0])?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
        }}
      >
        <ColorPicker
          value={pickerHex}
          onChange={pickCustom}
          presets={PRESET_SWATCHES}
          presetValue={draft?.kind === 'preset' ? draft.id : null}
          onPresetChange={pickPreset}
          presetsAction={
            <Button variant="outline" size="sm" disabled={!draft} onClick={resetDraft}>
              Reset to default
            </Button>
          }
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={hexId} className="text-xs text-muted-foreground">
            Custom colour (hex)
          </label>
          <Input
            id={hexId}
            value={hexText}
            placeholder="#RRGGBB"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={(hexTouched && hexInvalid) || undefined}
            aria-describedby={hexTouched && hexInvalid ? hexErrorId : undefined}
            onChange={(event) => onHexChange(event.target.value)}
            onBlur={() => setHexTouched(true)}
          />
          {hexTouched && hexInvalid && (
            <p id={hexErrorId} className="text-xs text-destructive">
              Enter a hex colour like #1a9 or #11aa99.
            </p>
          )}
        </div>
        <div className="flex min-h-5 flex-col gap-1">
          <p className="truncate text-sm font-medium text-muted-foreground" style={preview ? { color: preview.css } : undefined}>
            {repository.name}
          </p>
          <p role="status" className="text-xs text-muted-foreground">
            {draft?.kind === 'custom' && preview?.adjusted
              ? `Adjusted for readability (${adjustForContrast(draft.hex, background ?? [[0, 0, 0]]).hex}).`
              : ''}
            {nearState ? ` Close to the ${nearState} colour; it may read as an alert.` : ''}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            aria-disabled={!canApply || saving || undefined}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (canApply && !saving) void apply(draft)
            }}
          >
            {saving ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
