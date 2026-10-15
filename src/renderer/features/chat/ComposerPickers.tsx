// #564: the composer's model and reasoning pickers, inside the message box's own bottom row,
// replacing the old read-only CpuIcon/GaugeIcon line (FR-041, superseded by FR-064). Each is a
// labelled menu button naming the Session's current value (the same `lastModel`/
// `lastThinkingLevel` last-known values the old line read, T062/T063), so a Session whose agent
// is not running still shows its last value exactly as before.
//
// Rust (Tauri) build only: Stuart approved R13 (delete Electron) 2026-10-15, running concurrently
// in a separate worktree, so these pickers target `window.refract.model` directly -- non-optional
// now that Electron (the only other possible implementation, which never ported this family
// anyway) is gone (gate round 1, `shared/ipc.ts`).
//
// Disabled states (2026-10-15 grill, issue #564, decision 3): while the Session is working or
// needs-you ("not idle"), the picker refuses to open with "Available once the session is idle."
// in its accessible name, matching the underlying `request_rpc_if_idle` refusal
// (src-tauri/src/session/agent/lane_support.rs). While the Session is stopped (no running
// agent), the picker shows its last-known value but is ALSO disabled, with "Start the agent to
// change the model/reasoning level." in its name -- nothing is stored for the next start, since
// a disabled picker never calls the underlying IPC at all. Gate round 1 fix (code-reviewer
// HIGH): a picker menu left open when the Session's status flips to one of these states used to
// be impossible to close (Escape, an outside click, selecting an item were all swallowed the
// same way opening was refused) -- `onOpenChange` below now blocks only an attempt to OPEN while
// disabled, and a dedicated effect force-closes an already-open menu the instant `disabled`
// becomes true.
//
// Model picker (decision 6, gate round 1 rebuild): Radix `DropdownMenu.Content` is `role="menu"`,
// whose own typeahead moves focus to the first matching ITEM on every printable keystroke and
// blocks Tab/Home/End for anything but the content element itself -- a type-to-filter text field
// cannot coexist inside it (test-reviewer/code-reviewer HIGH: the previous build's filter field
// lost focus after one keystroke to Radix's own typeahead). Rebuilt as a `Popover` (which has a
// real, public `onOpenAutoFocus`) holding a combobox `<input>` plus a hand-built `role="listbox"`
// driven by `aria-activedescendant` -- the exact pattern `SlashMenu.tsx`/`MessageInput.tsx`
// already use for the slash-command menu: ArrowUp/Down move the active option, Enter applies it,
// Escape closes the popover and returns focus to the trigger (Radix Popover's own default close
// behaviour). A Roles group first (the Session's own role listing, `model.listRoles`, applied
// through the existing `model.applyRole` action -- the same action the Ctrl+R selector and
// `/role` already use), then the filtered catalog model list with the current one ticked,
// scrolling once the list passes about 12 rows -- capped further still by the popover's own
// `--radix-popover-content-available-height` so the filter field never scrolls off a short
// viewport (2026-10-15 grill follow-up, gate round 1).
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CheckIcon, CpuIcon, GaugeIcon, PaperclipIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatModelLabel, formatThinkingLevelLabel, THINKING_LEVEL_LABEL, THINKING_LEVELS } from '@/lib/modelDisplay'
import { attachImageFile } from './attachments'
import type { ModelCatalogEntry } from '../../../shared/model'
import { notify, useModelRolesStore, useSessionsStore } from '@/state'
import type { ThinkingLevel } from '../../../shared/ipc-model'

/** `notIdle`: the Session is working or needs-you -- the API's own mid-turn refusal rule.
 * `stopped`: no agent is running at all; a picker still shows the last-known value but cannot
 * change it either (decision 3). Either state disables the trigger, with its own reason text. */
function usePickerDisabled(sessionId: string) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status ?? 'stopped')
  const notIdle = status === 'working' || status === 'needs-you'
  const stopped = status === 'stopped'
  return { disabled: notIdle || stopped, notIdle, stopped }
}

/** Shared by both pickers (gate round 1 fix, code-reviewer HIGH): blocks only an attempt to
 * OPEN while disabled -- Escape, an outside click, and selecting an item all still close an
 * already-open menu even if `disabled` flipped true in the meantime -- and force-closes an
 * already-open menu the instant `disabled` itself becomes true (the Session starts a turn, or
 * stops, while the menu is sitting open). */
function usePickerOpenState(disabled: boolean) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  function onOpenChange(next: boolean) {
    if (next && disabled) return
    setOpen(next)
  }
  return { open, setOpen, onOpenChange }
}

const PICKER_TRIGGER_CLASS = cn(
  badgeVariants({ variant: 'outline' }),
  'h-6 shrink-0 gap-1.5 px-2.5 hover:bg-muted aria-expanded:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
  // Gate round 1 fix (MEDIUM): `badgeVariants`' own base focus ring is `ring-ring/50` (50%
  // alpha), below the WCAG 1.4.11 non-text 3:1 floor for a focus indicator. Opaque override,
  // the codebase's own `outline-ring` convention (`CollapsedLine.tsx`); `cn`'s Tailwind-merge
  // dedupes the conflicting `ring-color` utility so this wins over the base class above.
  'focus-visible:ring-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
)

export function ModelPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const { disabled, notIdle, stopped } = usePickerDisabled(sessionId)
  const { open, setOpen, onOpenChange } = usePickerOpenState(disabled)
  // Gate round 1 fix (MEDIUM): a friendly display name (`entry.name ?? session.lastModel.name`)
  // is not code-shaped data -- monospace is reserved for a raw `provider/id` fallback, which is
  // the only case this trigger label actually needs it (no catalog `name` was ever reported).
  const modelLabel = formatModelLabel(session ?? {})
  const modelLabelIsRaw = Boolean(session?.lastModel && !session.lastModel.name)
  const catalog = useModelRolesStore((s) => s.catalogs.chat)
  const catalogError = useModelRolesStore((s) => s.catalogErrors.chat)
  const loadCatalog = useModelRolesStore((s) => s.loadCatalog)
  const [filter, setFilter] = useState('')
  const [roles, setRoles] = useState<Array<{ role: string; model: string | null; current: boolean }> | null>(null)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const rolesHeadingId = useId()
  const modelsHeadingId = useId()

  useEffect(() => {
    if (!open) return
    void loadCatalog('chat')
    setFilter('')
    setActiveIndex(0)
    void window.refract.model.listRoles(sessionId).then((result) => {
      if (result.ok) {
        setRoles(result.value.roles)
        setRolesError(null)
      } else {
        setRoles([])
        setRolesError(result.error.message)
      }
    })
  }, [open, sessionId, loadCatalog])

  const filteredCatalog = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const entries = catalog ?? []
    if (!needle) return entries
    return entries.filter((entry) => `${entry.provider} ${entry.name}`.toLowerCase().includes(needle))
  }, [catalog, filter])

  const roleCount = roles?.length ?? 0
  const optionCount = roleCount + filteredCatalog.length
  const clampedActiveIndex = Math.min(activeIndex, Math.max(optionCount - 1, 0))
  const optionId = (index: number) => `${listboxId}-option-${index}`

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [clampedActiveIndex])

  async function handleSelectModel(entry: ModelCatalogEntry) {
    const result = await window.refract.model.setModel(sessionId, entry.provider, entry.id)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  async function handleSelectRole(role: string) {
    const result = await window.refract.model.applyRole(sessionId, role)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  function selectActiveOption() {
    if (clampedActiveIndex < roleCount) {
      const role = roles?.[clampedActiveIndex]
      if (role) void handleSelectRole(role.role)
    } else {
      const entry = filteredCatalog[clampedActiveIndex - roleCount]
      if (entry) void handleSelectModel(entry)
    }
    setOpen(false)
  }

  function handleFilterKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(optionCount - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      selectActiveOption()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  }

  /** The role list's own `model` field is a raw `provider/id` selector (never a friendly name,
   * #741); look it up against the already-loaded catalog for display, falling back to the raw
   * selector when the catalog hasn't loaded yet or doesn't list it -- `raw: true` in that
   * fallback case only, so the caller knows to keep it monospace (gate round 1 fix: a friendly
   * name is never code-shaped data). */
  function friendlyRoleModel(selector: string | null): { text: string; raw: boolean } {
    if (!selector) return { text: 'unset', raw: false }
    const match = (catalog ?? []).find((entry) => `${entry.provider}/${entry.id}` === selector)
    return match ? { text: match.name, raw: false } : { text: selector, raw: true }
  }

  const disabledSuffix = notIdle ? '. Available once the session is idle.' : stopped ? '. Start the agent to change the model.' : ''
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-disabled={disabled}
          aria-label={`Model: ${modelLabel ?? 'not known yet'}${disabledSuffix}`}
          title={modelLabel ?? undefined}
          className={PICKER_TRIGGER_CLASS}
        >
          <CpuIcon aria-hidden className="size-3" />
          <span className={cn('max-w-40 truncate', modelLabelIsRaw && 'font-code')}>{modelLabel ?? 'Model not known yet'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-72 flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          filterInputRef.current?.focus()
        }}
      >
        <div className="shrink-0 p-1">
          <Input
            ref={filterInputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={optionCount > 0 ? optionId(clampedActiveIndex) : undefined}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={handleFilterKeyDown}
            placeholder="Filter models…"
            aria-label="Filter models"
            className="h-7"
          />
        </div>
        <div ref={listRef} id={listboxId} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto">
          {roles !== null && roles.length > 0 && (
            <div role="group" aria-labelledby={rolesHeadingId}>
              <div id={rolesHeadingId} role="presentation" className="px-2 py-1 text-xs font-medium text-muted-foreground">
                Roles
              </div>
              {roles.map((role, index) => {
                const friendly = friendlyRoleModel(role.model)
                const active = index === clampedActiveIndex
                return (
                  <div
                    key={role.role}
                    id={optionId(index)}
                    role="option"
                    aria-selected={role.current}
                    data-active={active}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      void handleSelectRole(role.role)
                      setOpen(false)
                    }}
                    className={cn('flex cursor-default items-center gap-2 px-2 py-1.5 text-sm', active && 'bg-accent text-accent-foreground')}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {role.role} <span className={cn('text-xs text-muted-foreground', friendly.raw && 'font-code')}>{friendly.text}</span>
                    </span>
                    {role.current && <CheckIcon aria-hidden className="size-3.5 shrink-0" />}
                  </div>
                )
              })}
            </div>
          )}
          {rolesError && <p className="px-2 py-1 text-xs text-destructive">{rolesError}</p>}
          <div role="group" aria-labelledby={modelsHeadingId}>
            <div id={modelsHeadingId} role="presentation" className="px-2 py-1 text-xs font-medium text-muted-foreground">
              Models
            </div>
            {catalogError && (
              <div role="option" aria-disabled className="px-2 py-1.5 text-sm text-muted-foreground">
                {catalogError}
              </div>
            )}
            {!catalogError && filteredCatalog.length === 0 && (
              <div role="option" aria-disabled className="px-2 py-1.5 text-sm text-muted-foreground">
                {(catalog ?? []).length === 0 ? 'Loading models…' : 'No models match.'}
              </div>
            )}
            {!catalogError &&
              filteredCatalog.map((entry, modelIndex) => {
                const flatIndex = roleCount + modelIndex
                const active = flatIndex === clampedActiveIndex
                // Gate round 1 fix (MEDIUM, code-reviewer): compares identity (`provider` + `id`),
                // never the display label -- the old `modelLabel === \`${provider}/${name}\``
                // comparison missed a Session whose `lastModel.name` is absent and double-ticked
                // any two entries sharing a name.
                const checked = Boolean(
                  session?.lastModel && entry.provider === session.lastModel.provider && entry.id === session.lastModel.id
                )
                return (
                  <div
                    key={entry.selector}
                    id={optionId(flatIndex)}
                    role="option"
                    aria-selected={checked}
                    data-active={active}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      void handleSelectModel(entry)
                      setOpen(false)
                    }}
                    className={cn('flex cursor-default items-center gap-2 px-2 py-1.5 text-sm', active && 'bg-accent text-accent-foreground')}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
                    {checked && <CheckIcon aria-hidden className="size-3.5 shrink-0" />}
                  </div>
                )
              })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function ReasoningPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const { disabled, notIdle, stopped } = usePickerDisabled(sessionId)
  const { open, onOpenChange } = usePickerOpenState(disabled)
  const thinkingLabel = formatThinkingLevelLabel(session ?? {})

  async function handleSelect(level: ThinkingLevel) {
    const result = await window.refract.model.setThinkingLevel(sessionId, level)
    if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  }

  const label = thinkingLabel ?? 'Reasoning not known yet'
  const disabledSuffix = notIdle ? '. Available once the session is idle.' : stopped ? '. Start the agent to change the reasoning level.' : ''
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-disabled={disabled}
          aria-label={`Reasoning: ${label}${disabledSuffix}`}
          title={label}
          className={PICKER_TRIGGER_CLASS}
        >
          <GaugeIcon aria-hidden className="size-3" />
          <span>{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {/* Gate round 1 fix (code-reviewer HIGH): a `DropdownMenuRadioGroup`/`RadioItem` bound to
            the Session's current level, instead of a plain `DropdownMenuItem` with a decorative
            `aria-hidden` check icon -- Radix exposes the current one as `aria-checked`/
            `role="menuitemradio"` automatically, so a screen reader hears it. */}
        <DropdownMenuRadioGroup value={session?.lastThinkingLevel ?? undefined} onValueChange={(value) => void handleSelect(value as ThinkingLevel)}>
          {THINKING_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
              {THINKING_LEVEL_LABEL[level]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AttachButton({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    for (const file of Array.from(fileList)) {
      await attachImageFile(sessionId, file)
    }
  }

  return (
    <>
      {/* Gate round 1 fix (LOW): `hidden` rather than `sr-only` + `tabIndex={-1}` -- a screen
          reader's own browse mode no longer lands on a stray, do-nothing "Choose files" control
          that duplicates the visible Attach button below. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          void handleFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Attach images"
            aria-disabled={disabled}
            // Gate round 1 fix (LOW): the described-by Radix's own Tooltip auto-wires here would
            // just repeat this button's own accessible name ("Attach images" both places) -- a
            // screen reader would say it twice. Suppressed; the tooltip still shows visually.
            aria-describedby={undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => {
              if (disabled) return
              fileInputRef.current?.click()
            }}
          >
            <PaperclipIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Attach images</TooltipContent>
      </Tooltip>
    </>
  )
}
