// The composer's Model picker (#564 FR-064; gate round 1 rebuild, gate round 2 fixes). A
// labelled trigger naming the Session's current value (the same last-known `lastModel` value the
// old read-only line read, T062/T063), so a Session whose agent is not running still shows its
// last value exactly as before.
//
// Rust (Tauri) build only: `window.refract.model` is non-optional since Electron (the only other
// possible implementation, which never ported this family anyway) is gone (gate round 1,
// `shared/ipc.ts`).
//
// Disabled states (2026-10-15 grill, issue #564, decision 3): while the Session is working or
// needs-you ("not idle"), the picker refuses to open with "Available once the session is idle."
// in its accessible name. While the Session is stopped (no running agent), the picker shows its
// last-known value but is ALSO disabled, with "Start the agent to change the model." in its
// name -- nothing is stored for the next start, since a disabled picker never calls the
// underlying IPC at all. Gate round 2 (LOW): the disabled reason is now ALSO a visible Tooltip,
// not only the accessible name.
//
// Rebuilt as a Popover (gate round 1, decision 6): Radix `DropdownMenu.Content` is `role="menu"`,
// whose own typeahead moves focus to the first matching ITEM on every printable keystroke and
// blocks Tab/Home/End for anything but the content element itself -- a type-to-filter text field
// cannot coexist inside it. A Popover (which has a real, public `onOpenAutoFocus`) holds a
// combobox `<input>` plus a hand-built `role="listbox"` driven by `aria-activedescendant` -- the
// exact pattern `SlashMenu.tsx`/`MessageInput.tsx` already use for the slash-command menu:
// ArrowUp/Down move the active option, Enter applies it, Escape closes the popover and returns
// focus to the trigger (Radix Popover's own default close behaviour); Tab closes the popover and
// returns focus to the trigger too (gate round 2 LOW: Tab used to leave the non-modal popover
// open and send focus to whatever the portal's next DOM sibling happens to be). A Roles group
// first (the Session's own role listing, `model.listRoles`, applied through the existing
// `model.applyRole` action), then the filtered catalog model list with the current one ticked,
// scrolling once the list passes about 12 rows -- capped further still by the popover's own
// `--radix-popover-content-available-height` so the filter field never scrolls off a short
// viewport.
//
// Gate round 2 fixes (code-reviewer/accessibility-auditor):
// - The keyboard-active option was highlighted only by `bg-accent`, under 1.3:1 in every theme --
//   `PICKER_OPTION_ACTIVE_CLASS` (pickerShared.tsx) now adds the opaque `--active-indicator` left
//   border `SlashMenu.tsx` already uses for exactly this.
// - After typing in the filter, Enter applied the first ROLE (index 0 never moved off it, and
//   roles aren't filtered) -- the active index now resets to the first MATCHING MODEL whenever
//   the filter is non-empty.
// - Selection applied on `onMouseDown` (WCAG 2.5.2 Pointer Cancellation): `preventDefault` (kept,
//   so focus never leaves the filter field) stays on `onMouseDown`; the actual select-and-close
//   now runs on `onClick`, which only fires for a completed primary-button press-and-release on
//   the same element.
// - The popover had no accessible name (Radix gives it `role="dialog"` with none) -- `aria-label`
//   added.
// - A listbox had two `aria-selected="true"` items at once (the current role AND the current
//   model) -- the current ROLE is now sr-only "(current)" text plus the visible tick instead.
// - `rolesError` was a bare `<p>` directly inside `role="listbox"`, not an allowed child -- now a
//   disabled `role="option"`, matching `catalogError`'s own pattern.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CheckIcon, CpuIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatModelLabel } from '@/lib/modelDisplay'
import { notify, useModelRolesStore, useSessionsStore } from '@/state'
import type { ModelCatalogEntry } from '../../../shared/model'
import { PICKER_OPTION_ACTIVE_CLASS, PICKER_OPTION_CLASS, PICKER_TRIGGER_CLASS, usePickerDisabled, usePickerOpenState } from './pickerShared'

export function ModelPicker({ sessionId, boxDimmed }: { sessionId: string; boxDimmed: boolean }) {
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
  const triggerRef = useRef<HTMLButtonElement>(null)
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

  // Gate round 2 fix (MEDIUM, accessibility-auditor): roles are never filtered, so index 0 was
  // always the first role regardless of what was typed -- Enter after typing a search term
  // applied an unrelated role, not the match the developer typed to find. Once the filter is
  // non-empty, the active option starts at the first MODEL match instead.
  useEffect(() => {
    setActiveIndex(filter.trim() ? roleCount : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  // Gate round 3 fix (MEDIUM, code-reviewer): when a filter matches no model (roles are never
  // filtered), there must be no active option at all -- Enter does nothing and
  // `aria-activedescendant` points nowhere, instead of silently landing on (and applying) the
  // last unrelated role. Also fixes a race (LOW): deriving this at render from the latest
  // `roleCount` means an `activeIndex` set by the effect above before `listRoles` resolves gets
  // reclamped correctly the moment roles arrive, with no extra effect dependency needed.
  const activatableStart = filter.trim() ? roleCount : 0
  const activatableEnd = filter.trim() ? roleCount + filteredCatalog.length : optionCount
  const clampedActiveIndex =
    activatableEnd > activatableStart ? Math.min(Math.max(activeIndex, activatableStart), activatableEnd - 1) : null
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
    if (clampedActiveIndex === null) return
    if (clampedActiveIndex < roleCount) {
      const role = roles?.[clampedActiveIndex]
      if (role) void handleSelectRole(role.role)
    } else {
      const entry = filteredCatalog[clampedActiveIndex - roleCount]
      if (entry) void handleSelectModel(entry)
    }
    setOpen(false)
  }

  function closeAndReturnFocus() {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function handleFilterKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      // Gate round 3 fix (LOW, code-reviewer): steps from the clamped/VISIBLE index, not the raw
      // `activeIndex` (which can sit outside the current activatable range -- for example a role
      // index left over from before a filter narrowed the range to models only), and stays
      // within [activatableStart, activatableEnd) so arrowing can never land on a role while
      // filtering, nor run past the last filtered match.
      if (activatableEnd <= activatableStart) return
      setActiveIndex(Math.min((clampedActiveIndex ?? activatableStart - 1) + 1, activatableEnd - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (activatableEnd <= activatableStart) return
      setActiveIndex(Math.max((clampedActiveIndex ?? activatableStart) - 1, activatableStart))
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
      return
    }
    // Gate round 2 fix (LOW): Tab used to leave this non-modal popover open and carry focus to
    // whatever follows the portal in the DOM (the popover renders at the end of `<body>`), far
    // from the composer. Closing it first and returning focus to the trigger keeps Tab's own
    // normal meaning (leave this control) without stranding focus.
    if (event.key === 'Tab') {
      event.preventDefault()
      closeAndReturnFocus()
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

  const disabledReason = notIdle ? 'Available once the session is idle.' : stopped ? 'Start the agent to change the model.' : null
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-disabled={disabled}
              aria-label={`Model: ${modelLabel ?? 'not known yet'}${disabledReason ? `. ${disabledReason}` : ''}`}
              // Gate round 2 fix (LOW): the Tooltip's own content always duplicates something
              // already in the accessible name above (the model label when enabled, the
              // disabled reason when not) -- suppressed so a screen reader never says either
              // twice; the Tooltip itself still shows visually on hover and keyboard focus.
              aria-describedby={undefined}
              className={cn(PICKER_TRIGGER_CLASS, boxDimmed && 'aria-disabled:opacity-100')}
            >
              <CpuIcon aria-hidden className="size-3" />
              <span className={cn('max-w-40 truncate', modelLabelIsRaw && 'font-code')}>{modelLabel ?? 'Model not known yet'}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{disabledReason ?? modelLabel ?? 'Model not known yet'}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        aria-label="Choose model"
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
            aria-activedescendant={clampedActiveIndex !== null ? optionId(clampedActiveIndex) : undefined}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={handleFilterKeyDown}
            placeholder="Filter models…"
            aria-label="Filter models"
            className="h-7"
          />
        </div>
        <div ref={listRef} id={listboxId} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto">
          <div role="group" aria-labelledby={rolesHeadingId}>
            <div id={rolesHeadingId} role="presentation" className="px-2 py-1 text-xs font-medium text-muted-foreground">
              Roles
            </div>
            {roles !== null &&
              roles.map((role, index) => {
                const friendly = friendlyRoleModel(role.model)
                const active = index === clampedActiveIndex
                return (
                  <div
                    key={role.role}
                    id={optionId(index)}
                    role="option"
                    data-active={active}
                    // Gate round 3 fix (LOW, code-reviewer): a role is never in the activatable
                    // range while filtering (only matched models are), so hovering one must
                    // leave the keyboard index alone instead of pointing it at a row that isn't
                    // reachable by Enter -- a mouse move while the field still has keyboard focus
                    // must never fight the user's own typed intent.
                    onMouseEnter={() => {
                      if (!filter.trim()) setActiveIndex(index)
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      // Gate round 2 fix (MEDIUM, WCAG 2.5.2): selection moved here from
                      // `onMouseDown` -- `onClick` only fires for a completed primary-button
                      // press-and-release on this same element, so sliding off before releasing,
                      // or a non-primary button, can never apply it.
                      if (event.button !== 0) return
                      void handleSelectRole(role.role)
                      setOpen(false)
                    }}
                    className={cn(PICKER_OPTION_CLASS, active && PICKER_OPTION_ACTIVE_CLASS)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {role.role} <span className={cn('text-xs text-muted-foreground', friendly.raw && 'font-code')}>{friendly.text}</span>
                      {/* Gate round 2 fix (LOW): a listbox may have only one `aria-selected`
                          item -- the Models group below carries that role for the current
                          model, so the current role is sr-only text instead. */}
                      {role.current && <span className="sr-only"> (current)</span>}
                    </span>
                    {role.current && <CheckIcon aria-hidden className="size-3.5 shrink-0" />}
                  </div>
                )
              })}
            {rolesError && (
              <div role="option" aria-disabled className="px-2 py-1.5 text-sm text-muted-foreground">
                {rolesError}
              </div>
            )}
          </div>
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
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      if (event.button !== 0) return
                      void handleSelectModel(entry)
                      setOpen(false)
                    }}
                    className={cn(PICKER_OPTION_CLASS, active && PICKER_OPTION_ACTIVE_CLASS)}
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
