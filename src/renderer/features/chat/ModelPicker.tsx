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
//
// Gate round 5 fixes (fifth-gate UI/UX review, PR #877, `agent://Arch877`):
// - Visible trigger text is the model's bare `name` now, never `provider/name` -- every
//   screenshot showed about 400px of unused row with the label cut at 160px. `provider/name`
//   (via `formatModelLabel`) moves to the Tooltip and stays embedded in the accessible name
//   parenthetically, so neither surface loses the detail; list rows show the provider as muted
//   secondary text next to the name instead.
// - The popover's height is now FIXED while open (`h-[...]`, was `max-h-[...]`), so the list
//   (`flex-1 overflow-y-auto`) absorbs a changing result count instead of the filter field itself
//   jumping on screen as the match count changes.
// - The Roles group is hidden entirely once the filter is non-empty (decision 8's "Roles first"
//   only ever applied with no filter typed); a role whose own `model` is `null` AND has no
//   documented fallback (`ROLE_FALLBACK_LABEL`) is `aria-disabled` and excluded from the
//   keyboard-reachable set (`activatableIndices`, below) -- selecting it would resolve to
//   nothing, since OMP has nothing configured to fall back to either.
// - The catalog's three real states (loading, loaded-but-empty, filtered-to-nothing) now render
//   distinct text, with a `Loader2Icon` on the loading row; a cached load error now force-reloads
//   on every open (`loadCatalog('chat', true)` when `catalogError` is already set) and its row
//   gets a Retry action, instead of silently staying on the first failure forever.
// - Both `setModel`/`applyRole` now set a local `pendingLabel` for the duration of the call: the
//   trigger shows that requested value with a `Loader2Icon`, carries `aria-busy`, and the picker
//   cannot be reopened until the request settles (a failure still raises its existing toast).
// - The accessible name now starts with the trigger's own visible text (WCAG 2.5.3,
//   `docs/design/accessibility.md:16`), with the full `provider/name` kept parenthetically.
//
// Gate round 6 fixes (`agent://G564Code`, `agent://Arch877`, `agent://G564A11y`):
// - Empty trigger regression fixed: `?? 'Model not known yet'` (was a lowercase, non-sentence-
//   case `'not known yet'` fragment) -- FR-064's exact wording, matching the Tooltip and
//   `SessionDetailsCard.tsx`. The ", model" accessible-name suffix is now dropped when no model
//   is known at all (it read oddly stacked after "Model not known yet").
// - The catalog error row is no longer a `<button>` nested inside `role="option"` (an invalid,
//   screen-reader-invisible combination) -- it IS the option now, Enter-activatable like every
//   other row, with its own local `retrying` state (`Loader2Icon` + "Retrying…" + aria-disabled,
//   the same pattern `ModelRolesSection.tsx`'s own catalog retry uses) and never closes the
//   popover on activation. The whole listbox container also gets `onMouseDown` preventDefault
//   (not just each option), so a click anywhere inside it -- the Retry row unmounting mid-click
//   on success included -- can never drop focus to `<body>`.
// - `smol`/`slow`'s "Default" fallback wording moved INTO Settings' own `ROLE_FALLBACK_LABEL`
//   (`ModelRolesSection.tsx`), so this picker reads that map directly with no local duplicate --
//   Settings and this picker can no longer drift apart on the same five roles. A role with
//   neither a model nor a fallback (e.g. `plan`) now names that reason in its own "Inherited
//   (no fallback)" text, instead of a bare "Inherited" that never said why the row is disabled.
// - Pending state now carries `{ label, provider? }` (the role id standing in for `provider` on
//   a role pick) instead of a bare string -- the accessible name's parenthetical shows the NEW
//   value's own provider/role while applying, not the stale previous one.
// - The scroll-to-active-option effect is deferred one animation frame, so it runs after the
//   popover's own `--radix-popover-content-available-height` has settled, not mid-layout.
// - The popover's height cap raised 24rem -> 30rem (decision 6's "~12 rows" measured closer to 9
//   at 24rem once the filter field and padding are accounted for).
// - Catalog rows' provider text is now `text-xs`, matching the Roles group's own secondary text
//   size (was unset, inheriting the row's `text-sm`).
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CheckIcon, CpuIcon, Loader2Icon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { notify, useModelRolesStore, useSessionsStore } from '@/state'
import type { ModelCatalogEntry } from '../../../shared/model'
import { ModelCatalogGroup } from './ModelCatalogGroup'
import { ROLE_FALLBACK_LABEL } from '../settings/ModelRolesSection'
import { ROLE_LABEL } from '@/lib/modelRoles'
import { friendlyProviderLabel } from '@/lib/providerLabels'
import { PICKER_OPTION_ACTIVE_CLASS, PICKER_OPTION_CLASS, PICKER_TRIGGER_CLASS, usePickerDisabled, usePickerOpenState } from './pickerShared'

// Gate round 6 fix (`agent://Arch877` Flow L-N1): `smol`/`slow`'s "Default" fallback now lives
// IN the shared `ROLE_FALLBACK_LABEL` itself (`ModelRolesSection.tsx`), not merged in locally --
// Settings' own "Inherited" wording and this picker's "Inherited (...)" wording read the exact
// same map, so the two can never drift apart again. Re-typed to a plain `string` index below:
// `role` here is whatever id OMP's own `model.listRoles` reports, not guaranteed to be one of
// this app's closed `ModelRoleId` values.
const ROLE_FALLBACK: Partial<Record<string, string>> = ROLE_FALLBACK_LABEL

export function ModelPicker({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const { disabled, notIdle, stopped } = usePickerDisabled(sessionId)
  // Gate round 1 fix (MEDIUM): a friendly display name is not code-shaped data -- monospace is
  // reserved for a raw `provider/id` fallback. Gate round 1 fix (LOW #11): the Tooltip's
  // provider now reads through the shared `friendlyProviderLabel` map (`@/lib/providerLabels`),
  // not OMP's raw provider id (`SessionDetailsCard.tsx` already does the same).
  const modelFullLabel = session?.lastModel ? `${friendlyProviderLabel(session.lastModel.provider)}/${session.lastModel.name?.trim() || session.lastModel.id}` : null
  const modelLabelIsRaw = Boolean(session?.lastModel && !session.lastModel.name)
  // Gate round 5 fix (Layout/Flow/Visual Medium #3): the VISIBLE trigger text is the bare model
  // name (or raw id, the same `modelLabelIsRaw` case), never `provider/name` -- the full form
  // stays in the Tooltip and the accessible name's parenthetical below. Gate round 7 fix (Flow
  // Low, `agent://Arch877`): `name ?? id` kept an EMPTY-STRING `name`, leaving the trigger
  // visibly blank -- `?.trim() ||` falls through to `id` for both absent and blank names.
  const modelNameOnly = session?.lastModel ? (session.lastModel.name?.trim() || session.lastModel.id) : null
  const catalog = useModelRolesStore((s) => s.catalogs.chat)
  const catalogError = useModelRolesStore((s) => s.catalogErrors.chat)
  const loadCatalog = useModelRolesStore((s) => s.loadCatalog)
  const [filter, setFilter] = useState('')
  const [roles, setRoles] = useState<Array<{ role: string; model: string | null; current: boolean }> | null>(null)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Gate round 5 fix (Flow Medium #9): set for the duration of a `setModel`/`applyRole` call --
  // the trigger shows this requested value with a spinner, carries `aria-busy`, and the picker
  // refuses to reopen (folded into `usePickerOpenState`'s own `disabled` below) until the request
  // settles, so a second change can never start while the first is still in flight. Gate round 6
  // fix (`agent://Arch877` Layout N5/Flow L-N2): carries `{ label, provider? }` instead of a bare
  // string -- a MODEL pick's own `provider` is known immediately (no need to show the stale
  // PREVIOUS model's provider while a different one is being applied); a ROLE pick has no
  // provider of its own, so its own role id fills the same slot instead, naming which role is
  // resolving.
  const [pendingLabel, setPendingLabel] = useState<{ label: string; provider?: string } | null>(null)
  // Gate round 6 fix (`agent://Arch877` Medium 1, `agent://G564Code`/`agent://G564A11y` Low): the
  // catalog-error row's own in-flight state for an explicit Retry activation (reopening the
  // popover already force-reloads unconditionally, see the effect above; this is for retrying
  // WITHOUT closing and reopening).
  const [retrying, setRetrying] = useState(false)
  const initializedActiveRef = useRef(false)
  const effectiveDisabled = disabled || pendingLabel !== null
  const { open, setOpen, onOpenChange } = usePickerOpenState(effectiveDisabled)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const rolesHeadingId = useId()
  const modelsHeadingId = useId()

  useEffect(() => {
    if (!open) {
      initializedActiveRef.current = false
      return
    }
    // Gate round 5 fix (Flow Medium #8): a cached catalog error must not stay cached forever --
    // every open forces a fresh attempt when one is on record, instead of only ever trying once.
    // Gate round 7 fix (Flow Low, `agent://Arch877`): routed through `handleCatalogRetry` so this
    // automatic retry shows the SAME "Retrying…" feedback a manually-triggered one does.
    if (catalogError) {
      void handleCatalogRetry()
    } else {
      void loadCatalog('chat', false)
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, loadCatalog])

  const filteredCatalog = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const entries = catalog ?? []
    if (!needle) return entries
    return entries.filter((entry) => `${entry.provider} ${entry.name}`.toLowerCase().includes(needle))
  }, [catalog, filter])

  const roleCount = roles?.length ?? 0

  /** The role list's own `model` field is a raw `provider/id` selector (never a friendly name,
   * #741); look it up against the already-loaded catalog for display, falling back to the raw
   * selector when the catalog hasn't loaded yet or doesn't list it -- `raw: true` in that
   * fallback case only, so the caller knows to keep it monospace (gate round 1 fix: a friendly
   * name is never code-shaped data). Gate round 5 fix (Flow Medium #10): `model: null` no longer
   * shows a bare, unexplained "unset" -- reuses Settings' own "Inherited (...)" wording and
   * fallback mapping, so the sentinel says what it actually resolves to. Gate round 6 fix
   * (`agent://Arch877` Flow L-N1): a role with NEITHER a model NOR a documented fallback now
   * names that reason directly ("Inherited (no fallback)"), instead of a bare "Inherited" that
   * never said why the row is `aria-disabled`. */
  function friendlyRoleModel(role: string, selector: string | null): { text: string; raw: boolean; hasFallback: boolean } {
    if (!selector) {
      const fallback = ROLE_FALLBACK[role]
      return fallback
        ? { text: `Inherited (${fallback})`, raw: false, hasFallback: true }
        : { text: 'Inherited (no fallback)', raw: false, hasFallback: false }
    }
    const match = (catalog ?? []).find((entry) => `${entry.provider}/${entry.id}` === selector)
    return match ? { text: match.name, raw: false, hasFallback: true } : { text: selector, raw: true, hasFallback: true }
  }

  // Gate round 5 fix (Flow Medium #5, #10): the keyboard- and click-reachable flat indices, as a
  // SPARSE ordered list rather than the contiguous `[0, optionCount)` range gate round 3 assumed
  // -- a filter hides every role index entirely (decision 8: Roles First only with no filter),
  // and a role with no model AND no documented fallback is excluded even when roles ARE shown,
  // since selecting it would resolve to nothing. Gate round 6 fix (`agent://Arch877` Medium 1):
  // when a catalog load has failed, the ONE reachable "Models" index is the Retry row itself
  // (never a raw model row, since none loaded) -- Enter/click retries without closing the
  // popover.
  const activatableIndices = useMemo(() => {
    const indices: number[] = []
    if (!filter.trim() && roles) {
      roles.forEach((role, index) => {
        if (role.model !== null || ROLE_FALLBACK[role.role]) indices.push(index)
      })
    }
    if (catalogError) {
      indices.push(roleCount)
    } else {
      filteredCatalog.forEach((_, modelIndex) => indices.push(roleCount + modelIndex))
    }
    return indices
  }, [roles, filter, filteredCatalog, roleCount, catalogError])

  // Gate round 2 fix (MEDIUM, accessibility-auditor): roles are never filtered, so index 0 was
  // always the first role regardless of what was typed -- Enter after typing a search term
  // applied an unrelated role, not the match the developer typed to find. Once the filter is
  // non-empty, the active option starts at the first MODEL match instead.
  useEffect(() => {
    setActiveIndex(filter.trim() ? roleCount : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  // Gate round 5 fix (Layout LOW): once both the roles probe and the catalog have loaded for
  // this open, the active option starts on the CURRENT model (scrolled into view by the effect
  // below) rather than always the first role -- a guard ref runs this only once per open, so it
  // never fights the developer's own subsequent navigation.
  useEffect(() => {
    if (!open) return
    if (initializedActiveRef.current) return
    if (filter.trim()) return
    if (!catalog || roles === null) return
    const currentModelIndex = session?.lastModel
      ? filteredCatalog.findIndex((entry) => entry.provider === session.lastModel!.provider && entry.id === session.lastModel!.id)
      : -1
    if (currentModelIndex >= 0) setActiveIndex(roleCount + currentModelIndex)
    initializedActiveRef.current = true
  }, [open, catalog, roles, filter, filteredCatalog, roleCount, session])

  // Gate round 3 fix (MEDIUM, code-reviewer): when a filter matches no model (roles are never
  // filtered), there must be no active option at all -- Enter does nothing and
  // `aria-activedescendant` points nowhere, instead of silently landing on (and applying) the
  // last unrelated role. Gate round 5: generalised from a contiguous range to the sparse
  // `activatableIndices` list above, so a nearest-match lookup replaces a plain clamp.
  const clampedActiveIndex = useMemo(() => {
    if (activatableIndices.length === 0) return null
    if (activatableIndices.includes(activeIndex)) return activeIndex
    const next = activatableIndices.find((index) => index >= activeIndex)
    return next ?? activatableIndices[activatableIndices.length - 1]!
  }, [activatableIndices, activeIndex])
  const optionId = (index: number) => `${listboxId}-option-${index}`
  // Gate round 7 fix (Flow Low, `agent://Arch877`/`agent://G564A11y`): a distinct, non-numeric
  // id for the catalog-error Retry row -- it used to share `optionId(roleCount)` with whatever
  // model row would occupy that SAME flat index once the catalog loads, so a successful retry
  // could leave `aria-activedescendant` pointing at an id that now belongs to a different,
  // unrelated row (or stay unchanged if the two ids happened to coincide), announcing nothing.
  const retryOptionId = `${listboxId}-option-retry`
  const activeOptionDomId = (index: number) => (catalogError && index === roleCount ? retryOptionId : optionId(index))

  // Gate round 6 fix (`agent://Arch877` Layout N2, [INFERENCE]): deferred one animation frame --
  // `scrollIntoView` could run before the popover's own `--radix-popover-content-available-
  // height` (and so its real layout) has settled, leaving the highlighted current model below
  // the fold on a fresh open. Gate round 7 fix (Layout Low, `agent://Arch877`): added `open` to
  // the deps -- a reopen whose active index happens to equal the PREVIOUS open's (e.g. the
  // first role again) never re-ran this effect at all, so the list could open scrolled to the
  // top instead of showing the active row.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(raf)
  }, [open, clampedActiveIndex])

  async function handleSelectModel(entry: ModelCatalogEntry) {
    setPendingLabel({ label: entry.name, provider: entry.provider })
    try {
      const result = await window.refract.model.setModel(sessionId, entry.provider, entry.id)
      if (!result.ok) notify({ code: result.error.code, message: result.error.message })
    } finally {
      setPendingLabel(null)
    }
  }

  async function handleSelectRole(role: string, requestedLabel: string) {
    // Gate round 6 fix (`agent://Arch877` Layout N5/Flow L-N2): a role has no provider of its
    // own -- its own id fills that slot instead, so the pending parenthetical still names
    // something concrete about what is resolving, rather than the stale previous model.
    setPendingLabel({ label: requestedLabel, provider: role })
    try {
      const result = await window.refract.model.applyRole(sessionId, role)
      if (!result.ok) notify({ code: result.error.code, message: result.error.message })
    } finally {
      setPendingLabel(null)
    }
  }

  // Gate round 6 fix (`agent://Arch877` Medium 1): retrying a cached catalog error never closes
  // the popover (unlike a role/model pick) -- the developer stays put to see whether it worked.
  // Gate round 7 fix (Flow Low, `agent://Arch877`): `try`/`finally` -- `loadCatalog` always
  // resolves today (the store itself never rejects), but a future IPC failure must not leave
  // `retrying` stuck true forever, the same guard `handleSelectModel`/`handleSelectRole` already
  // have. Also called from the open effect now, so an automatic retry on reopen shows
  // "Retrying…" too, not just one started by activating the row directly.
  async function handleCatalogRetry() {
    if (retrying) return
    setRetrying(true)
    try {
      await loadCatalog('chat', true)
    } finally {
      setRetrying(false)
    }
  }

  function selectActiveOption() {
    if (clampedActiveIndex === null) return
    if (clampedActiveIndex < roleCount) {
      const role = roles?.[clampedActiveIndex]
      if (!role) return
      const friendly = friendlyRoleModel(role.role, role.model)
      if (!friendly.hasFallback && role.model === null) return
      void handleSelectRole(role.role, friendly.text)
      setOpen(false)
      return
    }
    if (catalogError) {
      if (clampedActiveIndex === roleCount) void handleCatalogRetry()
      return
    }
    const entry = filteredCatalog[clampedActiveIndex - roleCount]
    if (entry) void handleSelectModel(entry)
    setOpen(false)
  }

  function closeAndReturnFocus() {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function handleFilterKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      // Gate round 5 fix: steps by POSITION within the sparse `activatableIndices` list, not a
      // raw flat-index +/-1 -- a hidden-while-filtering role, or a no-fallback role, can never be
      // landed on this way, only skipped over entirely.
      if (activatableIndices.length === 0) return
      const position = clampedActiveIndex !== null ? activatableIndices.indexOf(clampedActiveIndex) : -1
      setActiveIndex(activatableIndices[Math.min(position + 1, activatableIndices.length - 1)]!)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (activatableIndices.length === 0) return
      const position = clampedActiveIndex !== null ? activatableIndices.indexOf(clampedActiveIndex) : activatableIndices.length
      setActiveIndex(activatableIndices[Math.max(position - 1, 0)]!)
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

  const disabledReason = notIdle ? 'Available once the session is idle.' : stopped ? 'Start the agent to change the model.' : null
  // Gate round 6 fix (`agent://G564Code` Medium): `?? 'Model not known yet'` -- FR-064's exact,
  // sentence-case wording (was a lowercase `'not known yet'` fragment this round's trigger-text
  // rework regressed to), matching the Tooltip and `SessionDetailsCard.tsx`.
  const triggerLabel = pendingLabel?.label ?? modelNameOnly ?? 'Model not known yet'
  // Gate round 5 fix (Flow Medium #11): the accessible name now STARTS with the trigger's own
  // visible text (WCAG 2.5.3, `docs/design/accessibility.md:16`); `provider/name` stays available
  // parenthetically here, and in full in the Tooltip below, rather than disappearing once the
  // visible text dropped to the bare name. Gate round 6 fix (`agent://G564Code` Medium): the
  // ", model" suffix is now dropped when no model is known at all -- "Model not known yet, model"
  // read oddly stacked. The parenthetical reads from `pendingLabel` while pending (round 6,
  // `agent://Arch877` L-N2), through the same `friendlyProviderLabel` map as the Tooltip (#11).
  const noModelKnown = pendingLabel === null && modelNameOnly === null
  const providerParenthetical = pendingLabel
    ? (pendingLabel.provider ? ` (${friendlyProviderLabel(pendingLabel.provider)})` : '')
    : session?.lastModel?.provider
      ? ` (${friendlyProviderLabel(session.lastModel.provider)})`
      : ''
  const ariaLabel = `${triggerLabel}${noModelKnown ? '' : ', model'}${providerParenthetical}${disabledReason ? `. ${disabledReason}` : pendingLabel ? '. Applying…' : ''}`
  const tooltipContent = disabledReason ?? (pendingLabel ? 'Applying…' : (modelFullLabel ?? 'Model not known yet'))
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-disabled={effectiveDisabled}
              aria-busy={pendingLabel !== null}
              aria-label={ariaLabel}
              // Gate round 2 fix (LOW): the Tooltip's own content always duplicates something
              // already in the accessible name above (the model label when enabled, the
              // disabled reason when not) -- suppressed so a screen reader never says either
              // twice; the Tooltip itself still shows visually on hover and keyboard focus.
              aria-describedby={undefined}
              className={cn(PICKER_TRIGGER_CLASS, 'max-w-72 min-w-0 shrink')}
            >
              {pendingLabel !== null ? (
                <Loader2Icon aria-hidden className="size-3 animate-spin" />
              ) : (
                <CpuIcon aria-hidden className="size-3" />
              )}
              <span className={cn('min-w-0 flex-1 truncate', pendingLabel === null && modelLabelIsRaw && 'font-code')}>{triggerLabel}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipContent}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        aria-label="Choose model"
        // Gate round 5 fix (Layout Medium #6): FIXED height while open (was `max-h-[...]`) -- the
        // list below is already `flex-1 overflow-y-auto`, so IT absorbs a changing result count
        // instead of the whole popover (and the filter field inside it) resizing and visibly
        // jumping as the match count changes. Gate round 6 fix (`agent://Arch877` Layout N7):
        // 24rem showed about 9 rows once the filter field and padding are accounted for, short of
        // decision 6's "~12 rows" -- raised to 30rem, still capped by `min()` against the
        // popover's own available height on a short viewport.
        className="flex h-[min(30rem,var(--radix-popover-content-available-height))] w-72 flex-col overflow-hidden p-0"
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
            aria-activedescendant={clampedActiveIndex !== null ? activeOptionDomId(clampedActiveIndex) : undefined}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={handleFilterKeyDown}
            placeholder="Filter models…"
            aria-label="Filter models"
            className="h-7"
          />
        </div>
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Models"
          className="min-h-0 flex-1 overflow-y-auto"
          // Gate round 6 fix (`agent://Arch877` Medium 1): a backstop alongside each option's own
          // `onMouseDown` preventDefault below -- covers the headings, the empty space between
          // groups, and the Retry row unmounting mid-click on a successful retry, none of which
          // had their own handler, so a click there could drop focus to `<body>` while the
          // popover stayed open.
          onMouseDown={(event) => event.preventDefault()}
        >
          {/* Gate round 5 fix (Flow Medium #5): hidden entirely once a filter is typed, not just
              excluded from the keyboard-reachable set -- decision 8's "Roles first" only ever
              meant the untouched, no-filter state. */}
          {!filter.trim() && (
            <div role="group" aria-labelledby={rolesHeadingId}>
              <div id={rolesHeadingId} role="presentation" className="px-2 py-1 text-xs font-medium text-muted-foreground">
                Roles
              </div>
              {/* Gate round 7 fix (Flow Low, `agent://G564Code`/`agent://G564A11y`): a loading row
                  while `listRoles` is still pending -- the heading used to show with nothing
                  under it, an unlabelled group for however long the probe took. */}
              {roles === null && !rolesError && (
                <div role="option" aria-disabled className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                  <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />
                  Loading roles…
                </div>
              )}
              {roles !== null &&
                roles.map((role, index) => {
                  const friendly = friendlyRoleModel(role.role, role.model)
                  const rowDisabled = !friendly.hasFallback && role.model === null
                  const active = index === clampedActiveIndex
                  return (
                    <div
                      key={role.role}
                      id={optionId(index)}
                      role="option"
                      aria-disabled={rowDisabled || undefined}
                      data-active={active}
                      onMouseEnter={() => {
                        if (!rowDisabled) setActiveIndex(index)
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        // Gate round 2 fix (MEDIUM, WCAG 2.5.2): selection moved here from
                        // `onMouseDown` -- `onClick` only fires for a completed primary-button
                        // press-and-release on this same element, so sliding off before releasing,
                        // or a non-primary button, can never apply it.
                        if (event.button !== 0) return
                        if (rowDisabled) return
                        void handleSelectRole(role.role, friendly.text)
                        setOpen(false)
                      }}
                      className={cn(PICKER_OPTION_CLASS, active && PICKER_OPTION_ACTIVE_CLASS, rowDisabled && 'cursor-not-allowed opacity-60')}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {(ROLE_LABEL as Partial<Record<string, string>>)[role.role] ?? role.role} <span className={cn('text-xs text-muted-foreground', friendly.raw && 'font-code')}>{friendly.text}</span>
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
          )}
          {/* Extracted to `ModelCatalogGroup.tsx` (gate round 6, issue #806's 600-line cap). */}
          <ModelCatalogGroup
            modelsHeadingId={modelsHeadingId}
            roleCount={roleCount}
            catalogError={catalogError}
            catalog={catalog}
            filteredCatalog={filteredCatalog}
            clampedActiveIndex={clampedActiveIndex}
            optionId={optionId}
            retryOptionId={retryOptionId}
            retrying={retrying}
            currentModel={session?.lastModel ?? null}
            onHoverIndex={setActiveIndex}
            onRetry={() => void handleCatalogRetry()}
            onSelectModel={(entry) => {
              void handleSelectModel(entry)
              setOpen(false)
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
