import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AlertTriangleIcon, DownloadIcon, FolderOpenIcon, FolderSearchIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { RowKebabMenu } from '@/components/RowKebabMenu'
import type { RowMenuEntry } from '@/components/RowKebabMenu'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RADIO_DOT_CLASS, RADIO_RING_CLASS } from '@/components/ui/radio-group'
import { ThemeSwatchChip } from '@/components/ui/theme-swatch-chip'
import { checkThemeContrast, describeWarning } from '@/lib/themeContrast'
import { cn } from '@/lib/utils'
import { useActiveThemeId, useThemeStore } from '@/state'
import { THEMES } from '../../../shared/themes'
import type { ThemeId } from '../../../shared/themes'
import { useThemeFileActions } from './useThemeFileActions'

// Hand-rolled radiogroup (roving tabindex): arrows and Home/End both move focus and save the choice.
// Not migrated to ui/radio-group.tsx, whose Home/End only move focus (#498).
const THEME_LIST = Object.values(THEMES)

interface Entry {
  key: string
  name: string
  swatch: string
  swatchPrimary: string
  builtin: ThemeId | null
  customId: string | null
}

const ROW_CLASS = 'group/radio-item flex min-w-0 flex-1 items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-glow'

interface ThemePickerProps {
  /** Ids of the heading and hint rendered in AppearanceSection. */
  labelledBy: string
  describedBy: string
}

export function ThemePicker({ labelledBy, describedBy }: ThemePickerProps) {
  const activeBuiltin = useActiveThemeId()
  const customId = useThemeStore((s) => s.customId)
  const customThemes = useThemeStore((s) => s.customThemes)
  const rejected = useThemeStore((s) => s.rejected)
  const save = useThemeStore((s) => s.save)
  const saveCustom = useThemeStore((s) => s.saveCustom)
  const actions = useThemeFileActions()
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState<string | null>(null)
  const refresh = useThemeStore((s) => s.refreshCustomThemes)

  useEffect(() => {
    void refresh()
  }, [refresh])
  const builtins: Entry[] = THEME_LIST.map((t) => ({ key: t.id, name: t.name, swatch: t.swatch, swatchPrimary: t.swatchPrimary, builtin: t.id, customId: null }))
  const customs: Entry[] = customThemes.map((t) => {
    const base = THEMES[t.base]
    return { key: `custom-${t.id}`, name: t.name, swatch: t.tokens.background ?? base.swatch, swatchPrimary: t.tokens.primary ?? base.swatchPrimary, builtin: null, customId: t.id }
  })
  const all = [...builtins, ...customs]
  const isActive = (e: Entry) => (e.customId !== null ? e.customId === customId : customId === null && e.builtin === activeBuiltin)

  // Choosing the active entry is a no-op so `save` doesn't round-trip over IPC for nothing.
  function choose(e: Entry) {
    if (isActive(e)) return
    if (e.customId !== null) void saveCustom(e.customId)
    else if (e.builtin) void save(e.builtin)
  }

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

  function renderRow(e: Entry, index: number) {
    const active = isActive(e)
    const custom = e.customId === null ? null : customThemes.find((t) => t.id === e.customId)
    const warnings = custom ? checkThemeContrast(custom) : []
    const entries: RowMenuEntry[] = custom
      ? [
          { id: 'export', label: 'Export…', icon: DownloadIcon, onSelect: () => void actions.exportCustom(custom) },
          { id: 'show', label: 'Show in folder', icon: FolderSearchIcon, onSelect: () => void actions.showInFolder(custom.id) },
          { id: 'remove', label: 'Remove…', icon: Trash2Icon, destructive: true, onSelect: () => actions.setPendingRemove(custom) }
        ]
      : [{ id: 'export', label: 'Export a copy…', icon: DownloadIcon, onSelect: () => void actions.exportBuiltin(e.builtin ?? 'dark', e.name) }]
    const nameId = `theme-option-${e.key}-name`
    return (
      <div key={e.key}>
        <RowKebabMenu entries={entries} label={`Actions for ${e.name}`}>
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
        {warnings.length > 0 && (
          <div className="px-2 pb-1">
            <Badge asChild variant="warning">
              <button type="button" id={`${nameId}-warn`} aria-expanded={open === e.key} onClick={() => setOpen(open === e.key ? null : e.key)}>
                <AlertTriangleIcon aria-hidden />
                {warnings.length} contrast {warnings.length === 1 ? 'warning' : 'warnings'}
              </button>
            </Badge>
            {open === e.key && (
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {warnings.map((w) => <li key={w.label}>{describeWarning(w)}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-sm">
      <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex flex-col gap-1">
        <p className="px-2 pt-1 text-xs text-muted-foreground">Built-in</p>
        {builtins.map((e, i) => renderRow(e, i))}
        {customs.length > 0 && <p className="px-2 pt-2 text-xs text-muted-foreground">Custom</p>}
        {customs.map((e, i) => renderRow(e, builtins.length + i))}
      </div>
      {rejected.map((r) => (
        <p key={r.file} role="alert" className="mt-2 px-2 text-xs text-destructive">Couldn&apos;t load {r.file}: {r.error}</p>
      ))}
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void actions.importTheme()}>
          <UploadIcon aria-hidden /> Import theme…
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void actions.showInFolder()}>
          <FolderOpenIcon aria-hidden /> Open themes folder
        </Button>
      </div>
      <ConfirmAlertDialog
        open={actions.pendingRemove !== null}
        busy={actions.busy}
        tone="destructive"
        title={`Remove ${actions.pendingRemove?.name ?? 'theme'}?`}
        description={
          actions.pendingRemove?.id === customId
            ? 'This deletes the theme file. Refract will switch to Dark.'
            : 'This deletes the theme file.'
        }
        confirmLabel="Remove"
        busyLabel="Removing…"
        onCancel={() => actions.setPendingRemove(null)}
        onConfirm={() => void actions.confirmRemove()}
        onCloseAutoFocus={() => false}
      />
    </div>
  )
}
