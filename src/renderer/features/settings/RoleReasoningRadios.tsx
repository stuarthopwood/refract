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
// activation), a local OPTIMISTIC `pendingLevel` so the checked dot moves the instant the user
// picks (rather than waiting out the write, which can include the unrelated #740 propagation
// sweep), and latest-pick-wins coalescing -- a second pick made while the first write is still in
// flight is held and sent once that write settles, rather than starting a second concurrent write
// or being silently dropped.
//
// Gate round 2 fix (High #1, N1): the coalesced write used to hold the FULL `${base}:${level}`
// value built at PICK time -- if a Select model change for the SAME role was still saving when
// the level was picked, `base` was the OLD model, so the held write silently reverted a model
// change that had already landed. The held pick now carries the LEVEL ONLY; `sendHeldLevel`
// rebuilds the value from `latestRef` (synced on every render, so the settle effect and the
// unmount flush below both always read the model/value THIS SAME COMMIT just settled on, never a
// stale closure), re-checks support against that fresh model, and skips the write entirely when
// the rebuilt value already matches what is already stored (also closes N5's redundant sweep). A
// held pick that survives to unmount (N2, the Settings section unmounting mid-save) is flushed
// through the same path rather than silently lost.
import { useEffect, useRef, useState } from 'react'
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

  // Gate round 1 fix (High #1), rebuilt gate round 2 (High #1, N1/N2): a local optimistic level
  // (so the dot moves at once) plus latest-pick-wins coalescing. The held pick now carries the
  // LEVEL ONLY -- `sendHeldLevel` rebuilds the value to send from `latestRef`, which is kept in
  // sync on every render (never only inside an effect), so whichever model/value THIS component
  // last rendered with is what a held pick is checked and built against, never a stale one
  // captured back when the pick was originally made.
  const [pendingLevel, setPendingLevel] = useState<string | null>(null)
  const pendingWriteRef = useRef<string | null>(null)
  const wasDisabledRef = useRef(disabled)
  const latestRef = useRef({ base, currentValue, catalogEntry })
  latestRef.current = { base, currentValue, catalogEntry }

  function sendHeldLevel(level: string): void {
    const { base: latestBase, currentValue: latestCurrentValue, catalogEntry: latestEntry } = latestRef.current
    const built = level === INHERIT_VALUE ? latestBase : `${latestBase}:${level}`
    if (!isLevelCarryable(level, latestEntry)) {
      setPendingLevel(null)
      announcePolite(`${roleLabel} reasoning reset to Inherit`)
      return
    }
    // Gate round 2 fix (N1/N5): the model this role is on may have changed (a Select save that
    // was still in flight when the level was picked) by the time this held pick is actually sent
    // -- skip the write entirely when the rebuilt value already matches what is already stored,
    // rather than firing a redundant (or actively reverting) sweep.
    if (built === (latestCurrentValue ?? '')) {
      setPendingLevel(null)
      return
    }
    setPendingLevel(level)
    onPick(built)
  }

  useEffect(() => {
    if (wasDisabledRef.current && !disabled) {
      const level = pendingWriteRef.current
      pendingWriteRef.current = null
      if (level !== null) sendHeldLevel(level)
      else setPendingLevel(null)
    }
    wasDisabledRef.current = disabled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  useEffect(() => {
    // Gate round 2 fix (N2): a held pick that survives to unmount (the Settings section itself
    // unmounting mid-save, `SettingsScreen.tsx`) is flushed through the SAME rebuild-and-check
    // path, rather than the user's own pick silently vanishing.
    return () => {
      const level = pendingWriteRef.current
      pendingWriteRef.current = null
      if (level !== null) sendHeldLevel(level)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentLevel = pendingLevel ?? storedLevel

  function pick(level: string): void {
    if (disabled) {
      pendingWriteRef.current = level
      setPendingLevel(level)
      // Gate round 2 fix (Medium #4): distinct wording from the Select's own "{label} is still
      // saving" (a DROPPED pick) -- this pick is accepted and QUEUED, not dropped.
      announcePolite(`${roleLabel} reasoning: your pick will apply when the save finishes`)
      return
    }
    setPendingLevel(level)
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
  // Gate round 2 fix (Medium #3): judged against the STORED level, never the (possibly pending,
  // not yet saved) `currentLevel` -- arrowing to a different level while this one is still in
  // flight must not make the Auto/Max item disappear before that pick actually lands.
  const isStoredUnknownLevel = storedLevel !== INHERIT_VALUE && !KNOWN_LEVELS.has(storedLevel)

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
        {isStoredUnknownLevel && (
          <ReasoningRadioItem
            id={`model-role-${role}-reasoning-${storedLevel}`}
            value={storedLevel}
            label={UNKNOWN_LEVEL_LABEL[storedLevel] ?? storedLevel}
            disabled={false}
            pending={disabled && currentLevel === storedLevel}
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
        'min-h-6 w-auto flex-row items-center gap-1.5 rounded-none border-none bg-transparent px-0 py-0 text-xs font-normal hover:bg-transparent focus-visible:ring-2 data-[state=checked]:border-none data-[state=checked]:bg-transparent disabled:cursor-not-allowed disabled:opacity-50',
        // Gate round 2 fix (Visual Medium #2): `opacity-80` read too close to the disabled
        // `opacity-50` treatment -- a filled background makes the pending item unmistakable
        // instead of merely a little less faded.
        pending && 'rounded bg-accent/70'
      )}
    >
      <span aria-hidden className={RADIO_RING_CLASS}>
        <RadioGroupIndicator className={RADIO_DOT_CLASS} />
      </span>
      {label}
    </RadioGroupItem>
  )
}
