import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AlertTriangleIcon, ChevronDownIcon, DownloadIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { REVEAL_ACTION_LABEL, RevealActionIcon } from '@/components/revealAction'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { InlineStatus } from '@/components/InlineStatus'
import { RowKebabMenu } from '@/components/RowKebabMenu'
import type { RowMenuEntry } from '@/components/RowKebabMenu'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RADIO_DOT_CLASS, RADIO_RING_CLASS } from '@/components/ui/radio-group'
import { ThemeSwatchChip } from '@/components/ui/theme-swatch-chip'
import { checkThemeContrast, describeWarning } from '@/lib/themeContrast'
import { cn } from '@/lib/utils'
import { useThemeEntries } from '@/lib/useThemeEntries'
import type { ThemeEntry } from '@/lib/useThemeEntries'
import { useThemeStore } from '@/state'
import { useThemeFileActions } from './useThemeFileActions'

// Hand-rolled radiogroup (roving tabindex): arrows and Home/End both move focus and save the choice.
// Not migrated to ui/radio-group.tsx, whose Home/End only move focus (#498).
const ROW_CLASS = 'group/radio-item flex min-w-0 flex-1 items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-glow'

interface ThemePickerProps {
  /** Ids of the heading and hint rendered in AppearanceSection. */
  labelledBy: string
  describedBy: string
}

export function ThemePicker({ labelledBy, describedBy }: ThemePickerProps) {
  const { builtins, customs, all, customThemes, customId, isActive, choose: chooseEntry } = useThemeEntries()
  const rejected = useThemeStore((s) => s.rejected)
  const actions = useThemeFileActions()
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const pendingIndex = useRef(0)
  const [open, setOpen] = useState<string | null>(null)
  const refresh = useThemeStore((s) => s.refreshCustomThemes)
  const contrast = useMemo(() => new Map(customThemes.map((t) => [t.id, checkThemeContrast(t)])), [customThemes])

  useEffect(() => {
    void refresh()
  }, [refresh])
  const choose = (e: ThemeEntry) => void chooseEntry(e)

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(index + 1, all.length - 1)
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(index - 1, 0)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = all.length - 1
    const target = next === null ? undefined : all[next]
    if (next === null || !target) return
    event.preventDefault()
    choose(target)
    buttonRefs.current[next]?.focus()
  }

  function renderRow(e: ThemeEntry, index: number) {
    const active = isActive(e)
    const custom = e.customId === null ? null : customThemes.find((t) => t.id === e.customId)
    const warnings = custom ? (contrast.get(custom.id) ?? []) : []
    const entries: RowMenuEntry[] = custom
      ? [
          { id: 'export', label: 'Export…', icon: DownloadIcon, onSelect: () => void actions.exportCustom(custom) },
          { id: 'show', label: REVEAL_ACTION_LABEL, icon: RevealActionIcon, onSelect: () => void actions.showInFolder(custom.id) },
          { id: 'remove', label: 'Remove…', icon: Trash2Icon, destructive: true, onSelect: () => { pendingIndex.current = index; actions.setPendingRemove(custom) } }
        ]
      : [{ id: 'export', label: 'Export a copy…', icon: DownloadIcon, onSelect: () => void actions.exportBuiltin(e.builtin ?? 'dark', e.name) }]
    const nameId = `theme-option-${e.key}-name`
    return (
      <div key={e.key}>
        <RowKebabMenu
          entries={entries}
          label={`Actions for ${e.name}`}
          below={
            warnings.length > 0 && (
              <div className="px-2 pb-1">
                <Badge asChild variant="warning">
                  <button type="button" id={`${nameId}-warn`} aria-expanded={open === e.key} aria-controls={open === e.key ? `${nameId}-warn-list` : undefined} onClick={() => setOpen(open === e.key ? null : e.key)}>
                    <AlertTriangleIcon aria-hidden />
                    {warnings.length} contrast {warnings.length === 1 ? 'warning' : 'warnings'}
                    <ChevronDownIcon aria-hidden className={cn('transition-transform', open === e.key && 'rotate-180')} />
                  </button>
                </Badge>
                {open === e.key && (
                  <ul id={`${nameId}-warn-list`} className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                    {warnings.map((w) => <li key={`${w.fg}|${w.bg}`}>{describeWarning(w)}</li>)}
                  </ul>
                )}
              </div>
            )
          }
        >
          <button
            ref={(node) => {
              buttonRefs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={active}
            data-state={active ? 'checked' : 'unchecked'}
            aria-labelledby={nameId}
            aria-describedby={warnings.length ? `${nameId}-warn` : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => choose(e)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(ROW_CLASS, active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-row-hover-bg hover:text-foreground')}
          >
            <span aria-hidden className={RADIO_RING_CLASS}>
              {active && <span className={RADIO_DOT_CLASS} />}
            </span>
            <span id={nameId} className="min-w-0 flex-1 truncate">{e.name}</span>
            <ThemeSwatchChip swatch={e.swatch} swatchPrimary={e.swatchPrimary} />
          </button>
        </RowKebabMenu>
      </div>
    )
  }

  return (
    <div className="max-w-sm">
      <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex flex-col gap-1">
        <p className="px-2 pt-1 text-xs text-muted-foreground">Built-in themes</p>
        {builtins.map((e, i) => renderRow(e, i))}
        {customs.length > 0 && <p className="px-2 pt-2 text-xs text-muted-foreground">Custom</p>}
        {customs.map((e, i) => renderRow(e, builtins.length + i))}
      </div>
      {rejected.map((r) => (
        <InlineStatus key={r.file} tone="error" density="compact" className="mt-2">Couldn&apos;t load {r.file}: {r.error}</InlineStatus>
      ))}
      {actions.importError && <InlineStatus tone="error" density="compact" className="mt-2">{actions.importError}</InlineStatus>}
      <div className="mt-4 flex gap-2">
        <Button type="button" variant="outline" size="sm" className="aria-disabled:opacity-50" aria-disabled={actions.importing} onClick={() => { if (!actions.importing) void actions.importTheme() }}>
          <UploadIcon aria-hidden /> {actions.importing ? 'Importing…' : 'Import theme…'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void actions.showInFolder()}>
          <RevealActionIcon aria-hidden /> Show themes folder
        </Button>
      </div>
      <ConfirmAlertDialog
        open={actions.pendingRemove !== null}
        busy={actions.busy}
        tone="destructive"
        title={`Remove ${actions.pendingRemove?.name ?? 'theme'}?`}
        description={
          actions.pendingRemove?.id === customId
            ? 'This deletes the theme file. Refract will switch back to your built-in theme.'
            : 'This deletes the theme file.'
        }
        confirmLabel="Remove"
        busyLabel="Removing…"
        onCancel={() => actions.setPendingRemove(null)}
        error={actions.removeError}
        onConfirm={() => void actions.confirmRemove()}
        onCloseAutoFocus={() => {
          const target = actions.removed.current ? all.findIndex(isActive) : pendingIndex.current
          buttonRefs.current[Math.max(target, 0)]?.focus()
        }}
      />
    </div>
  )
}
