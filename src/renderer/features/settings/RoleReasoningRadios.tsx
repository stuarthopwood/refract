// Issue #1069 decision 4: one reasoning-level radio group per CHAT role (never shown for the 5
// model-kind roles, decision 6). Uses the Radix-backed primitives plus the shared contrast-fixed
// ring/dot class strings from #1043/PR #1057 (`RADIO_RING_CLASS`/`RADIO_DOT_CLASS`), matching
// `AskCard.tsx`/`MergeDialog.tsx`'s structure but NOT either file's own older inline ring
// (`border-primary`, which measures under 3:1 in three themes -- `radio-group.tsx`'s own header).
//
// Gate round 1 fix (PR #1114, High #1): a native `disabled` on the FOCUSED item while a save was
// in flight dropped keyboard focus to `<body>` the instant Radix's own roving-focus-group
// noticed the active item had left the tab order -- combined with Radix selecting on every arrow
// key (`@radix-ui/react-radio-group/dist/index.mjs:370`, `ref.current?.click()` on an
// arrow-driven focus move), a single ArrowRight during a save fired a SECOND write before the
// first had even settled. Native `disabled` is now reserved for a genuinely UNSUPPORTED level
// (`reason !== null`) -- Inherit is never disabled, and a save in flight no longer disables
// anything natively. Instead: `aria-busy` on the GROUP (informational only, never blocks
// activation) and a local OPTIMISTIC `pendingLevel` so the checked dot moves the instant the
// user picks (rather than waiting out the write, which can include the unrelated #740
// propagation sweep).
//
// Gate round 3 fix (Decided Skippy/Stuart 2026-10-21, removes a whole class of bugs rounds 1/2
// kept patching instead of removing): a radio pick is held ONLY while THIS COMPONENT'S OWN write
// (`ownWriteInFlightRef`) is in flight -- never while some OTHER save for the same role (a
// Select model change) is pending. While a model change is saving, a radio pick is REFUSED
// outright: focus stays, the dot doesn't move, nothing is held, one announcement per save. This
// removes, at the root rather than by patching each symptom: the held-pick-reverts-a-landed-
// model-change class (round 2's N1), the drop-and-disable-focus class, the failed-model-save
// class (a held level landing against the OLD model once an errored save clears), and the wrong
// "reset to Inherit" drop announcement -- none of these can happen if a pick is never held
// against a save the radios didn't themselves start. Because a held pick can now ONLY ever be
// held against the SAME model this component is already showing, `sendHeldLevel` never needs a
// carryability check: the model cannot have changed out from under the radios' own write. On
// unmount (the Settings section itself unmounting mid-save, `SettingsScreen.tsx`), any held
// level is DROPPED -- no write, no announcement; round 2's flush-on-unmount effect is deleted
// (it was the mechanism that let a stale held level write itself after a Select save had already
// landed on a different model -- N1/N2's actual root cause).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2Icon } from 'lucide-react'
import { RadioGroup, RadioGroupIndicator, RadioGroupItem, RADIO_DOT_CLASS, RADIO_RING_CLASS } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'
import type { ModelCatalogEntry } from '../../../shared/model'
import { splitThinkingSuffix } from './modelRoleSuffix'

type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
const INHERIT_VALUE = 'inherit'

// Decision 4's exact seven options; `xhigh` is the suffix vocabulary's own token for "Extra
// high" (`modelRoleSuffix.ts`'s `THINKING_SUFFIX_RE`). `off`/`auto`/`max` also exist in that
// vocabulary but `auto`/`max` are not part of this seven-option UI -- a value already carrying
// one of those two (Stuart's real config has `:auto` on several chat roles) instead renders as
// one extra, checked-only item (see `UNKNOWN_LEVEL_LABEL` below), never silently showing no
// level checked at all (gate round 1, High #3).
const LEVELS: ReadonlyArray<{ value: ReasoningLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' }
]
const KNOWN_LEVELS = new Set<string>(LEVELS.map((l) => l.value))

// Gate round 1 (#1114, High #3, Decided Skippy/Stuart 2026-10-21): rendered ONLY while the
// role's own STORED value carries one of these suffixes (gate round 2, Medium #3: kept rendered
// even while a DIFFERENT level is merely PENDING, not yet saved, so arrowing off it and back is
// still possible -- it disappears only once a different level is actually SAVED). A literal
// `:inherit` suffix needs no entry here: `currentLevel` already maps it onto `INHERIT_VALUE`
// directly (the same string), so it shows as a normal checked Inherit. **Known limitation (gate
// round 2, confirmed, not a round-1 claim)**: Radix only fires `onValueChange` on a genuine VALUE
// change, so re-picking the ALREADY-checked Inherit item when the stored suffix is the literal
// token `:inherit` fires no event at all -- that literal suffix cannot be cleared from this UI.
// Deferred (Main, gate round 2): low-probability (nothing in this app ever WRITES a literal
// `:inherit` suffix; it could only arise from a hand-edited config), doesn't block.
const UNKNOWN_LEVEL_LABEL: Record<string, string> = { auto: 'Auto', max: 'Max' }

/** Whether `level` (one of the seven UI options) is supported by `entry` -- exported so
 * `ModelRolesSection.tsx`'s own suffix carry-over (picking a new model for a role that already
 * has a level set) can check the SAME support rule this component's own disabled state uses,
 * rather than a second copy that could drift (gate round 1, Medium #5). */
export function isReasoningLevelSupported(level: string, entry: ModelCatalogEntry | undefined): boolean {
  if (!entry) return false
  if (level === 'off') return entry.reasoning
  return entry.thinking?.includes(level) ?? false
}

/** Whether `level` (which may be `inherit`, one of the seven UI options, or an out-of-vocabulary
 * token like `auto`/`max`) survives a carry-over onto `entry` -- shared by `ModelRolesSection.tsx`
 * (picking a new model) and this file's own held-pick rebuild (gate round 2, Medium #2). `inherit`
 * always carries (it writes no suffix at all); `auto` is model-independent (real `omp` never
 * reports it as a catalog `thinking` level, confirmed live, `fixtures/model-catalogs/README.md`)
 * so it carries whenever the model supports reasoning at all; every other token (including `max`,
 * which IS a real catalog level) uses the ordinary per-model support check. */
export function isLevelCarryable(level: string, entry: ModelCatalogEntry | undefined): boolean {
  if (level === INHERIT_VALUE) return true
  if (level === 'auto') return entry?.reasoning ?? false
  return isReasoningLevelSupported(level, entry)
}

export interface RoleReasoningRadiosProps {
  /** `ModelRoleId`, used only to build each option's own DOM id. */
  role: string
  /** The role's own visible display label (e.g. "Default"): the group's own accessible name is
   * "{roleLabel} Reasoning", and the in-flight announcements name the role the same way the
   * Select's own announcements do. */
  roleLabel: string
  /** The role's own visible label element id (`aria-labelledby`, combined with this component's
   * own sr-only "Reasoning" label below) -- a named radiogroup per role, never a second generic
   * "Reasoning" name repeated across all ten (accessibility section). */
  labelId: string
  /** The role's raw stored value (possibly `:level`-suffixed), or `undefined` when unset. */
  currentValue: string | undefined
  /** The CURRENT value's own catalog entry, resolved against the FULL (unfiltered) catalog --
   * never the provider-filtered list, since the enabled set follows the role's actual model
   * regardless of the selected provider (decision 4). `undefined` when the value is unset or not
   * found in the catalog at all. */
  catalogEntry: ModelCatalogEntry | undefined
  /** Gate round 2 fix (Medium #6): whether the CATALOG itself (not this one role's own value) is
   * still loading or failed to load -- while it is, nothing about `catalogEntry` being `undefined`
   * can be trusted as "this model is unknown", so the caption stays silent instead of guessing. */
  catalogStatus: 'loading' | 'loaded' | 'error'
  /** True while a save for this role is in flight -- mirrors the Select's own pending guard. */
  disabled: boolean
  onPick(nextValue: string): void
  /** Mirrors the Select's own in-flight announcement region (`ModelRolesSection.tsx`'s own
   * `useClearedAnnouncement` polite region). */
  announcePolite(message: string): void
}

/** Decision 4: Inherit is always enabled (it writes no suffix); every other level is enabled only
 * when the role's chosen model itself supports it (`reasoning`/`thinking`, confirmed present in
 * `omp models --kind chat --json`) -- a disabled item is explained by ONE visible caption below
 * the row (gate round 1, High #4: the issue's own accessibility AC asks for visible text, never
 * only a screen-reader-only reason read as part of the radio's own name). */
export function RoleReasoningRadios({ role, roleLabel, labelId, currentValue, catalogEntry, catalogStatus, disabled, onPick, announcePolite }: RoleReasoningRadiosProps) {
  const { base, suffix } = currentValue ? splitThinkingSuffix(currentValue) : { base: '', suffix: null }
  const storedLevel = suffix ? suffix.slice(1) : INHERIT_VALUE // ':high' -> 'high'
  const hasValue = currentValue !== undefined
  // Gate round 2 fix (Medium #6): a catalog that hasn't finished loading (or failed) can never
  // tell "unresolved" apart from "not fetched yet" -- only a LOADED catalog missing the selector
  // is genuinely "Unknown model".
  const unresolvedModel = hasValue && !catalogEntry && catalogStatus === 'loaded'

  // Gate round 1 fix (High #1): a local optimistic level (so the dot moves at once). Gate round
  // 3 rewrite: `heldLevelRef` only ever holds a pick made while THIS component's own write
  // (`ownWriteInFlightRef`) is in flight -- never against some other pending save for the same
  // role, which is refused outright in `pick` below instead of being queued.
  const [pendingLevel, setPendingLevel] = useState<string | null>(null)
  const heldLevelRef = useRef<string | null>(null)
  const ownWriteInFlightRef = useRef(false)
  const wasDisabledRef = useRef(disabled)
  const queuedAnnouncedRef = useRef(false)
  const latestRef = useRef({ base, currentValue })
  latestRef.current = { base, currentValue }

  // Only ever called to flush a level held against THIS component's OWN write settling -- the
  // model cannot have changed out from under that write (it is the SAME role, same write), so
  // unlike round 2's version this never needs a carryability re-check.
  function sendHeldLevel(level: string): void {
    const { base: latestBase, currentValue: latestCurrentValue } = latestRef.current
    const built = level === INHERIT_VALUE ? latestBase : `${latestBase}:${level}`
    if (built === (latestCurrentValue ?? '')) {
      setPendingLevel(null)
      return
    }
    setPendingLevel(level)
    ownWriteInFlightRef.current = true
    onPick(built)
  }

  useEffect(() => {
    if (wasDisabledRef.current && !disabled) {
      // A save just settled. Only flush a held level if it was OUR OWN write that was pending --
      // if some OTHER save (a Select model change) was pending instead, every pick made during
      // it was REFUSED outright below, so there is nothing held to flush.
      if (ownWriteInFlightRef.current) {
        ownWriteInFlightRef.current = false
        const level = heldLevelRef.current
        heldLevelRef.current = null
        if (level !== null) sendHeldLevel(level)
        else setPendingLevel(null)
      }
    }
    if (!wasDisabledRef.current && disabled) queuedAnnouncedRef.current = false
    wasDisabledRef.current = disabled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  // Gate round 3 fix (decision 2): no flush-on-unmount effect. A held level that survives to
  // unmount (the Settings section itself unmounting mid-save) is simply DROPPED -- no write, no
  // announcement -- rather than firing after the user has already navigated away.

  const currentLevel = pendingLevel ?? storedLevel

  // Gate round 3 fix (Main, post-review): a REFUSED pick still focuses the radio the user
  // clicked (native button click behaviour) even though no state changes -- if that level is
  // supported by the OLD model but not the NEW one once a Select model save lands, the focused
  // item goes from enabled to natively `disabled`, and the browser blurs a disabled element to
  // `<body>` synchronously, as part of React applying that attribute. A layout effect (runs
  // after every commit, still before paint) can't stop that blur, but moves focus back to the
  // group's own CHECKED item (always enabled by definition) before the user perceives it,
  // falling back to Inherit (never disabled) on the rare chance even that fails.
  useLayoutEffect(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLButtonElement)) return
    if (!active.id.startsWith(`model-role-${role}-reasoning-`)) return
    if (!active.disabled) return
    const checkedEl = document.getElementById(`model-role-${role}-reasoning-${currentLevel}`)
    if (checkedEl instanceof HTMLButtonElement && !checkedEl.disabled) checkedEl.focus()
    else document.getElementById(`model-role-${role}-reasoning-inherit`)?.focus()
  })

  function pick(level: string): void {
    if (disabled) {
      if (ownWriteInFlightRef.current) {
        heldLevelRef.current = level
        setPendingLevel(level)
        if (!queuedAnnouncedRef.current) {
          queuedAnnouncedRef.current = true
          // Gate round 2 fix (Medium #4): distinct wording from the Select's own "{label} is
          // still saving" (a DROPPED pick) -- this pick is accepted and QUEUED, not dropped.
          announcePolite(`${roleLabel} reasoning: your pick will apply when the save finishes`)
        }
        return
      }
      // Gate round 3 fix (decision 1): some OTHER save for this role (a Select model change) is
      // in flight -- REFUSE outright. Focus stays, the dot doesn't move, nothing is held.
      if (!queuedAnnouncedRef.current) {
        queuedAnnouncedRef.current = true
        announcePolite(`${roleLabel} model is still saving; choose a level when it finishes`)
      }
      return
    }
    setPendingLevel(level)
    ownWriteInFlightRef.current = true
    onPick(level === INHERIT_VALUE ? base : `${base}:${level}`)
  }

  function levelDisabled(level: ReasoningLevel): boolean {
    if (!hasValue || unresolvedModel) return true
    return !isReasoningLevelSupported(level, catalogEntry)
  }

  // Gate round 1 fix (High #4): ONE visible, combined caption per role -- e.g. "Medium, High and
  // Extra high aren't supported by GPT 3.5 Turbo" -- never a per-item reason that would make the
  // radio's own accessible name read the reason TWICE (once as content, once via its own
  // `aria-describedby` pointing right back at itself).
  function reasonCaption(): string | null {
    // Gate round 2 fix (Medium #6): stay silent while the catalog itself hasn't settled --
    // `renderCatalogStatus` already shows the real loading/error state for the whole kind.
    if (catalogStatus !== 'loaded') return null
    if (!hasValue) return 'Pick a model first'
    if (unresolvedModel) return 'Unknown model'
    // Gate round 2 fix (Medium #6): a model that doesn't reason at all gets one short line,
    // never a list of all six levels repeating the same fact six times.
    if (!catalogEntry!.reasoning) return `${catalogEntry!.name} doesn't support reasoning`
    const unsupported = LEVELS.filter((l) => !isReasoningLevelSupported(l.value, catalogEntry)).map((l) => l.label)
    if (unsupported.length === 0) return null
    const joined = unsupported.length === 1 ? unsupported[0] : `${unsupported.slice(0, -1).join(', ')} and ${unsupported[unsupported.length - 1]}`
    return `${joined} ${unsupported.length === 1 ? "isn't" : "aren't"} supported by ${catalogEntry!.name}`
  }

  const caption = reasonCaption()
  const captionId = caption ? `${labelId}-reasoning-reason` : undefined
  const reasoningLabelId = `${labelId}-reasoning-label`
  // Gate round 2 fix (Medium #3) + gate round 3 fix (decision 4, N-A): rendered while EITHER the
  // STORED value or the CURRENT (possibly pending) one carries an unknown token -- judging the
  // stored value alone let the focused item unmount out from under the user the instant a
  // pending pick to a KNOWN level actually SAVED, since the focused DOM node disappears before
  // Radix's own roving tabindex has anywhere else to send focus.
  const isStoredUnknownLevel = storedLevel !== INHERIT_VALUE && !KNOWN_LEVELS.has(storedLevel)
  const isCurrentUnknownLevel = currentLevel !== INHERIT_VALUE && !KNOWN_LEVELS.has(currentLevel)
  const unknownLevelToShow = isStoredUnknownLevel ? storedLevel : isCurrentUnknownLevel ? currentLevel : null

  return (
    <>
      <RadioGroup
        aria-labelledby={`${labelId} ${reasoningLabelId}`}
        aria-describedby={captionId}
        aria-busy={disabled || undefined}
        className="mt-2 flex flex-row flex-wrap gap-x-4 gap-y-1.5"
        value={currentLevel}
        onValueChange={(value) => {
          if (value === INHERIT_VALUE) pick(INHERIT_VALUE)
          else if (hasValue && !unresolvedModel) pick(value)
        }}
      >
        <span id={reasoningLabelId} className="sr-only">
          Reasoning
        </span>
        <ReasoningRadioItem id={`model-role-${role}-reasoning-inherit`} value={INHERIT_VALUE} label="Inherit" disabled={false} pending={disabled && currentLevel === INHERIT_VALUE} />
        {LEVELS.map(({ value, label }) => (
          <ReasoningRadioItem
            key={value}
            id={`model-role-${role}-reasoning-${value}`}
            value={value}
            label={label}
            disabled={levelDisabled(value)}
            pending={disabled && currentLevel === value}
          />
        ))}
        {unknownLevelToShow !== null && (
          <ReasoningRadioItem
            id={`model-role-${role}-reasoning-${unknownLevelToShow}`}
            value={unknownLevelToShow}
            label={UNKNOWN_LEVEL_LABEL[unknownLevelToShow] ?? unknownLevelToShow}
            disabled={false}
            pending={disabled && currentLevel === unknownLevelToShow}
          />
        )}
      </RadioGroup>
      {disabled && (
        // Gate round 2 fix (Medium #5): the Select's own "Saving…" sits next to the trigger
        // (still needed there -- it is the ONLY pending cue the 5 model-kind roles have, which
        // never render this component at all); this one sits right where a keyboard/radio user
        // is actually looking, immediately under the row they just picked in.
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2Icon aria-hidden className="size-3 shrink-0 animate-spin" />
          Saving…
        </p>
      )}
      {caption && (
        <p id={captionId} className="mt-1 text-xs text-muted-foreground">
          {caption}
        </p>
      )}
    </>
  )
}

function ReasoningRadioItem({
  id,
  value,
  label,
  disabled,
  pending
}: {
  id: string
  value: string
  label: string
  disabled: boolean
  pending: boolean
}) {
  return (
    <RadioGroupItem
      id={id}
      value={value}
      disabled={disabled}
      className={cn(
        'min-h-6 w-auto flex-row items-center gap-1.5 rounded-none border-none bg-transparent px-0 py-0 text-xs font-normal hover:bg-transparent focus-visible:ring-2 data-[state=checked]:border-none disabled:cursor-not-allowed disabled:opacity-50',
        // Gate round 2 fix (Visual Medium #2): a filled background makes the pending item
        // unmistakable. Gate round 3 fix (Medium #6): the base `data-[state=checked]:bg-
        // transparent` and a plain `bg-accent/70` have the SAME specificity once checked (the
        // `[data-state="checked"]` attribute selector always wins a tie against a bare class),
        // so the fill never drew on a checked (i.e. actually pending) item -- moved to its own
        // mutually-exclusive `data-[state=checked]:bg-accent/70`, never present alongside the
        // transparent one on the same element.
        pending ? 'rounded bg-accent/70 data-[state=checked]:bg-accent/70' : 'data-[state=checked]:bg-transparent'
      )}
    >
      <span aria-hidden className={RADIO_RING_CLASS}>
        <RadioGroupIndicator className={RADIO_DOT_CLASS} />
      </span>
      {label}
    </RadioGroupItem>
  )
}
