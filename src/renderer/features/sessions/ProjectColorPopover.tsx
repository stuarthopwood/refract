import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ColorPicker } from '@/components/ColorPicker'
import { PROJECT_PRESETS, adjustForContrast, nearStateColor, parseHex, projectColorCss } from '@/lib/projectColor'
import { useSidebarRgb } from './useSidebarRgb'
import type { ProjectColor, Repository } from '../../../shared/model'

// Issue #887: the Project colour popover opened from a Project header's "..." menu. Edits a
// draft only; nothing is saved until Apply, and Esc (or Cancel) leaves the saved colour as it was.
export function ProjectColorPopover({
  repository,
  open,
  onOpenChange,
  onApply,
  returnFocusRef,
  children
}: {
  repository: Repository
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Resolves to an error message, or `null` on success (the same contract as `rename`). */
  onApply: (color: ProjectColor | null) => Promise<string | null>
  returnFocusRef: React.RefObject<HTMLElement | null>
  /** The element the popover anchors to. */
  children: React.ReactNode
}) {
  const [draft, setDraft] = useState<ProjectColor | null>(repository.color ?? null)
  const [hexText, setHexText] = useState(repository.color?.kind === 'custom' ? repository.color.hex : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const background = useSidebarRgb()

  useEffect(() => {
    if (!open) return
    setDraft(repository.color ?? null)
    setHexText(repository.color?.kind === 'custom' ? repository.color.hex : '')
    setError(null)
    // Only a fresh open resets the draft; a saved change while open must not clobber it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const hexInvalid = hexText.trim() !== '' && !parseHex(hexText)
  const preview = projectColorCss(draft ?? undefined, background)
  const nearState = draft?.kind === 'custom' ? nearStateColor(draft.hex) : null
  const pickerHex = draft?.kind === 'custom' ? draft.hex : (parseHex(hexText) ? hexText.trim() : '#7c9cf0')

  function pickCustom(hex: string) {
    setHexText(hex)
    setDraft({ kind: 'custom', hex })
    setError(null)
  }

  function onHexChange(text: string) {
    setHexText(text)
    setError(null)
    if (parseHex(text)) setDraft({ kind: 'custom', hex: text.trim() })
  }

  async function apply(color: ProjectColor | null) {
    setSaving(true)
    const message = await onApply(color)
    setSaving(false)
    if (message) setError(message)
    else onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex">{children}</span>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        aria-label={`Project colour for ${repository.name}`}
        className="flex w-64 flex-col gap-3"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
        }}
      >
        <RadioGroup
          aria-label="Preset colours"
          value={draft?.kind === 'preset' ? draft.id : ''}
          onValueChange={(id) => {
            setDraft({ kind: 'preset', id })
            setHexText('')
            setError(null)
          }}
          className="grid grid-cols-5 gap-2"
        >
          {PROJECT_PRESETS.map((preset, index) => (
            <RadioGroupItem
              key={preset.id}
              value={preset.id}
              aria-label={preset.name}
              title={preset.name}
              style={{ backgroundColor: `var(--project-${index + 1})` }}
              className="size-8 w-8 items-center justify-center rounded-md border-transparent px-0 py-0 hover:opacity-90 data-[state=checked]:border-foreground data-[state=checked]:ring-2 data-[state=checked]:ring-foreground"
            />
          ))}
        </RadioGroup>
        <div className="flex flex-col gap-1">
          <label htmlFor="project-color-hex" className="text-xs text-muted-foreground">
            Custom colour (hex)
          </label>
          <Input
            id="project-color-hex"
            value={hexText}
            placeholder="#RRGGBB"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={hexInvalid || undefined}
            aria-describedby={hexInvalid ? 'project-color-hex-error' : undefined}
            onChange={(event) => onHexChange(event.target.value)}
          />
          {hexInvalid && (
            <p id="project-color-hex-error" role="alert" className="text-xs text-destructive">
              Enter a hex colour like #1a9 or #11aa99.
            </p>
          )}
        </div>
        <ColorPicker value={pickerHex} onChange={pickCustom} />
        <div className="flex min-h-5 flex-col gap-0.5">
          <p className="truncate text-sm font-medium text-muted-foreground" style={preview ? { color: preview.css } : undefined}>
            {repository.name}
          </p>
          <p role="status" className="text-xs text-muted-foreground">
            {draft?.kind === 'custom' && preview?.adjusted
              ? `Adjusted for readability (${adjustForContrast(draft.hex, background ?? [0, 0, 0]).hex}).`
              : ''}
            {nearState ? ` Close to the ${nearState} colour; it may read as an alert.` : ''}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" disabled={saving || (!repository.color && !draft)} onClick={() => void apply(null)}>
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving || hexInvalid || !draft} onClick={() => void apply(draft)}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
