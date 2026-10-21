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
// anything natively. Instead: `aria-disabled`/`aria-busy` on the GROUP (informational only, never
// blocks activation), a local OPTIMISTIC `pendingLevel` so the checked dot moves the instant the
// user picks (rather than waiting out the write, which can include the unrelated #740
// propagation sweep), and latest-pick-wins coalescing -- a second pick made while the first write
// is still in flight is held in `pendingWriteRef` and sent once that write settles, rather than
// starting a second concurrent write or being silently dropped. Arrowing across several levels
// during one save costs at most TWO writes total (the first, plus one coalesced trailing write),
// never one per keypress, and focus never leaves the radio the user is actually on.
import { useEffect, useRef, useState } from 'react'
import { RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { RADIO_DOT_CLASS, RADIO_RING_CLASS } from '@/components/ui/radio-group'
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
// role's own current value carries exactly this suffix; picking any OTHER level replaces it. A
// literal `:inherit` suffix needs no entry here -- `currentLevel` below already maps it onto
// `INHERIT_VALUE` directly (the same string), so it shows as a normal checked Inherit, and
// picking Inherit (or any other level) already strips any existing suffix via `base`.
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

export interface RoleReasoningRadiosProps {
  /** `ModelRoleId`, used only to build each option's own DOM id -- kept as a plain string so this
   * component never needs the shared model types just for an id prefix. */
  role: string
  /** The role's own visible display label (e.g. "Default"): the group's own accessible name is
   * "{roleLabel} Reasoning", and the "is still saving" announcement names the role the same way
   * the Select's own in-flight announcement already does (gate round 1, High #1/#4). */
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
  /** True while a save for this role is in flight -- mirrors the Select's own pending guard. */
  disabled: boolean
  onPick(nextValue: string): void
  /** Mirrors the Select's own in-flight announcement (`ModelRolesSection.tsx`'s own
   * `useClearedAnnouncement` polite region) -- "{roleLabel} reasoning is still saving" when a
   * pick is made while a save for this SAME role is already in flight. */
  announcePolite(message: string): void
}

/** Decision 4: Inherit is always enabled (it writes no suffix); every other level is enabled only
 * when the role's chosen model itself supports it (`reasoning`/`thinking`, confirmed present in
 * `omp models --kind chat --json`) -- a disabled item is explained by ONE visible caption below
 * the row (gate round 1, High #4: the issue's own accessibility AC asks for visible text, never
 * only a screen-reader-only reason read as part of the radio's own name). */
export function RoleReasoningRadios({ role, roleLabel, labelId, currentValue, catalogEntry, disabled, onPick, announcePolite }: RoleReasoningRadiosProps) {
  const { base, suffix } = currentValue ? splitThinkingSuffix(currentValue) : { base: '', suffix: null }
  const storedLevel = suffix ? suffix.slice(1) : INHERIT_VALUE // ':high' -> 'high'
  const hasValue = currentValue !== undefined
  // Gate round 1 fix (Medium #8): a set value this catalog cannot resolve at all (an alias, or a
  // model missing from this run's catalog fetch) is "Unknown model", never "Pick a model first"
  // -- the two are different problems with different fixes for the user.
  const unresolvedModel = hasValue && !catalogEntry

  // Gate round 1 fix (High #1): a local optimistic level (so the dot moves at once) plus
  // latest-pick-wins coalescing (a pick made while a write is already in flight is HELD, not
  // fired immediately, and sent once that write settles -- at most one extra write, ever).
  const [pendingLevel, setPendingLevel] = useState<string | null>(null)
  const pendingWriteRef = useRef<{ value: string; level: string } | null>(null)
  const wasDisabledRef = useRef(disabled)

  useEffect(() => {
    if (wasDisabledRef.current && !disabled) {
      const coalesced = pendingWriteRef.current
      pendingWriteRef.current = null
      if (coalesced) {
        setPendingLevel(coalesced.level)
        onPick(coalesced.value)
      } else {
        setPendingLevel(null)
      }
    }
    wasDisabledRef.current = disabled
  }, [disabled, onPick])

  const currentLevel = pendingLevel ?? storedLevel

  function pick(value: string, level: string): void {
    if (disabled) {
      pendingWriteRef.current = { value, level }
      setPendingLevel(level)
      announcePolite(`${roleLabel} reasoning is still saving`)
      return
    }
    setPendingLevel(level)
    onPick(value)
  }

  // Gate round 1 fix: a level is disabled whenever there is no resolvable model to check
  // support against (no value set, or a set value this catalog cannot resolve) -- the REASON
  // text itself lives only in the combined group caption below (High #4), never per item.
  function levelDisabled(level: ReasoningLevel): boolean {
    if (!hasValue || unresolvedModel) return true
    return !isReasoningLevelSupported(level, catalogEntry)
  }

  // Gate round 1 fix (High #4): ONE visible, combined caption per role -- e.g. "Medium, High and
  // Extra high aren't supported by GPT 3.5 Turbo" -- never a per-item reason that would make the
  // radio's own accessible name read the reason TWICE (once as content, once via its own
  // `aria-describedby` pointing right back at itself).
  function reasonCaption(): string | null {
    if (!hasValue) return 'Pick a model first'
    if (unresolvedModel) return 'Unknown model'
    const unsupported = LEVELS.filter((l) => !isReasoningLevelSupported(l.value, catalogEntry)).map((l) => l.label)
    if (unsupported.length === 0) return null
    const joined = unsupported.length === 1 ? unsupported[0] : `${unsupported.slice(0, -1).join(', ')} and ${unsupported[unsupported.length - 1]}`
    return `${joined} ${unsupported.length === 1 ? "isn't" : "aren't"} supported by ${catalogEntry!.name}`
  }

  const caption = reasonCaption()
  const captionId = caption ? `${labelId}-reasoning-reason` : undefined
  const reasoningLabelId = `${labelId}-reasoning-label`
  const isUnknownLevel = currentLevel !== INHERIT_VALUE && !KNOWN_LEVELS.has(currentLevel)

  return (
    <>
      <RadioGroup
        aria-labelledby={`${labelId} ${reasoningLabelId}`}
        aria-describedby={captionId}
        aria-disabled={disabled || undefined}
        aria-busy={disabled || undefined}
        className="mt-2 flex flex-row flex-wrap gap-x-4 gap-y-1.5"
        value={currentLevel}
        onValueChange={(value) => {
          if (value === INHERIT_VALUE) pick(base, INHERIT_VALUE)
          else if (hasValue && !unresolvedModel) pick(`${base}:${value}`, value)
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
        {isUnknownLevel && (
          <ReasoningRadioItem
            id={`model-role-${role}-reasoning-${currentLevel}`}
            value={currentLevel}
            label={UNKNOWN_LEVEL_LABEL[currentLevel] ?? currentLevel}
            disabled={false}
            pending={disabled}
          />
        )}
      </RadioGroup>
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
        'min-h-6 w-auto flex-row items-center gap-1.5 rounded-none border-none bg-transparent px-0 py-0 text-xs font-normal hover:bg-transparent focus-visible:ring-2 data-[state=checked]:border-none data-[state=checked]:bg-transparent disabled:cursor-not-allowed disabled:opacity-50',
        // Gate round 1 fix (Visual Medium #2): the pending (saving) treatment must look
        // different from "unsupported" (both used `opacity-50` before this fix).
        pending && 'opacity-80'
      )}
    >
      <span aria-hidden className={RADIO_RING_CLASS}>
        <RadioGroupIndicator className={RADIO_DOT_CLASS} />
      </span>
      {label}
    </RadioGroupItem>
  )
}
