// One reasoning-level radio group per chat role (#1069), using the contrast-fixed ring/dot classes (#1043).
// Native `disabled` is reserved for unsupported levels: disabling the focused item mid-save drops focus,
// and Radix selects on arrow keys, so an arrow during a save would fire a second write (#1114).
// A pick is held only while this component's own write is in flight; during any other save for the
// role it is refused outright, so a held level can never land against a different model. Held
// levels are dropped on unmount.
import { useLayoutEffect, useRef, useState } from 'react'
import { Loader2Icon } from 'lucide-react'
import { RadioGroup, RadioGroupIndicator, RadioGroupItem, RADIO_DOT_CLASS, RADIO_RING_CLASS } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'
import { COMPOSER_DISABLED_OPACITY_CLASS } from '../chat/pickerShared'
import type { ModelCatalogEntry } from '../../../shared/model'
import { splitThinkingSuffix } from './modelRoleSuffix'

type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
const INHERIT_VALUE = 'inherit'

// `xhigh` is the suffix token for "Extra high". A stored `auto`/`max` renders as one extra checked-only
// item (`UNKNOWN_LEVEL_LABEL`) so no level is ever silently unchecked.
const LEVELS: ReadonlyArray<{ value: ReasoningLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' }
]
const KNOWN_LEVELS = new Set<string>(LEVELS.map((l) => l.value))

// Rendered while the stored (or pending) value carries `auto`/`max`, so arrowing off it and back stays possible.
// A literal `:inherit` suffix maps to Inherit; re-picking it fires no Radix event, so it cannot be cleared
// from this UI (only a hand-edited config can contain it).
const UNKNOWN_LEVEL_LABEL: Record<string, string> = { auto: 'Auto', max: 'Max' }

/** Whether `level` (one of the seven UI options) is supported by `entry`; shared with `ModelRolesSection.tsx`'s suffix carry-over. */
export function isReasoningLevelSupported(level: string, entry: ModelCatalogEntry | undefined): boolean {
  if (!entry) return false
  if (level === 'off') return entry.reasoning
  return entry.thinking?.includes(level) ?? false
}

/** Whether `level` (inherit, one of the seven options, or `auto`/`max`) survives a carry-over onto `entry`.
 * `inherit` always carries; `auto` is model-independent, so it carries whenever the model reasons at all. */
export function isLevelCarryable(level: string, entry: ModelCatalogEntry | undefined): boolean {
  if (level === INHERIT_VALUE) return true
  if (level === 'auto') return entry?.reasoning ?? false
  return isReasoningLevelSupported(level, entry)
}

export interface RoleReasoningRadiosProps {
  /** `ModelRoleId`, used only to build each option's DOM id. */
  role: string
  /** The role's visible display label (e.g. "Default"); the group's accessible name is "{roleLabel} Reasoning". */
  roleLabel: string
  /** The role's visible label element id, combined with an sr-only "Reasoning" label so each radiogroup has a unique name. */
  labelId: string
  /** The role's raw stored value (possibly `:level`-suffixed), or `undefined` when unset. */
  currentValue: string | undefined
  /** The value's catalog entry from the full (unfiltered) catalog; `undefined` when unset or not found. */
  catalogEntry: ModelCatalogEntry | undefined
  /** Whether the catalog itself is loading or failed; the caption stays silent then instead of guessing. */
  catalogStatus: 'loading' | 'loaded' | 'error'
  /** True while a save for this role is in flight. */
  disabled: boolean
  onPick(nextValue: string): void
  /** Mirrors the Select's polite in-flight announcement region. */
  announcePolite(message: string): void
}

/** Inherit is always enabled; other levels only when the chosen model supports them, with one visible caption explaining any disabled item. */
export function RoleReasoningRadios({ role, roleLabel, labelId, currentValue, catalogEntry, catalogStatus, disabled, onPick, announcePolite }: RoleReasoningRadiosProps) {
  const { base, suffix } = currentValue ? splitThinkingSuffix(currentValue) : { base: '', suffix: null }
  const storedLevel = suffix ? suffix.slice(1) : INHERIT_VALUE // ':high' -> 'high'
  const hasValue = currentValue !== undefined
  // Only a loaded catalog missing the selector is genuinely "Unknown model".
  const unresolvedModel = hasValue && !catalogEntry && catalogStatus === 'loaded'

  // Optimistic level so the dot moves at once; `heldLevelRef` holds only picks made during our own write.
  const [pendingLevel, setPendingLevel] = useState<string | null>(null)
  const heldLevelRef = useRef<string | null>(null)
  const ownWriteInFlightRef = useRef(false)
  const wasDisabledRef = useRef(disabled)
  const queuedAnnouncedRef = useRef(false)
  const lastUnknownLevelRef = useRef<string | null>(null)
  const [focusedLevel, setFocusedLevel] = useState<string | null>(null)
  const latestRef = useRef({ base, currentValue })
  latestRef.current = { base, currentValue }

  // Only flushes a level held against our own write, so the model cannot have changed: no carryability re-check.
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

  // A layout effect, not a passive one (#1127): it runs before paint, so a click cannot land
  // between the DOM update that re-enables the radios and this settle step observing it.
  useLayoutEffect(() => {
    if (wasDisabledRef.current && !disabled) {
      // Flush only after our own write; picks during another save were refused, so nothing is held.
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

  // No flush-on-unmount: a held level surviving unmount is dropped, not written after navigation.

  const currentLevel = pendingLevel ?? storedLevel

  // A refused pick still focuses its radio; if the new model then disables it, the browser blurs to
  // <body>. Move focus back to the checked item (or Inherit) before paint.
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
          // Wording differs from the Select's "still saving": this pick is queued, not dropped.
          announcePolite(`${roleLabel} reasoning: your pick will apply when the save finishes`)
        }
        return
      }
      // Another save for this role is in flight (also true after a remount): refuse, hold nothing.
      if (!queuedAnnouncedRef.current) {
        queuedAnnouncedRef.current = true
        announcePolite(`${roleLabel} is still saving; choose a level when it finishes`)
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

  // One combined caption per role, not per-item reasons, so a radio's accessible name never reads the reason twice.
  function reasonCaption(): string | null {
    // Silent until the catalog settles; `renderCatalogStatus` shows loading/error.
    if (catalogStatus !== 'loaded') return null
    if (!hasValue) return 'Pick a model first'
    if (unresolvedModel) return 'Unknown model'
    // A non-reasoning model gets one short line, not a list of every level.
    if (!catalogEntry!.reasoning) return `${catalogEntry!.name} doesn't support reasoning`
    const unsupported = LEVELS.filter((l) => !isReasoningLevelSupported(l.value, catalogEntry)).map((l) => l.label)
    if (unsupported.length === 0) return null
    const joined = unsupported.length === 1 ? unsupported[0] : `${unsupported.slice(0, -1).join(', ')} and ${unsupported[unsupported.length - 1]}`
    return `${joined} ${unsupported.length === 1 ? "isn't" : "aren't"} supported by ${catalogEntry!.name}`
  }

  const caption = reasonCaption()
  const captionId = caption ? `${labelId}-reasoning-reason` : undefined
  const reasoningLabelId = `${labelId}-reasoning-label`
  // Rendered while the stored or current value is unknown, else the focused item unmounts when a pending pick saves.
  const isStoredUnknownLevel = storedLevel !== INHERIT_VALUE && !KNOWN_LEVELS.has(storedLevel)
  const isCurrentUnknownLevel = currentLevel !== INHERIT_VALUE && !KNOWN_LEVELS.has(currentLevel)
  const storedOrCurrentUnknown = isStoredUnknownLevel ? storedLevel : isCurrentUnknownLevel ? currentLevel : null
  // #1127 (WCAG 2.4.3): keep the focused unknown radio rendered (dimmed) until focus leaves it. Idempotent, safe to replay.
  if (storedOrCurrentUnknown !== null) lastUnknownLevelRef.current = storedOrCurrentUnknown
  else if (focusedLevel !== lastUnknownLevelRef.current) lastUnknownLevelRef.current = null
  const unknownLevelToShow = storedOrCurrentUnknown ?? lastUnknownLevelRef.current

  return (
    <>
      <RadioGroup
        aria-labelledby={`${labelId} ${reasoningLabelId}`}
        aria-describedby={captionId}
        aria-busy={disabled || undefined}
        className="mt-2 flex flex-row flex-wrap gap-x-4 gap-y-2"
        value={currentLevel}
        onFocus={(e) => setFocusedLevel(e.target instanceof HTMLElement ? e.target.id.slice(`model-role-${role}-reasoning-`.length) : null)}
        // A blur with no `relatedTarget` while the window lost focus (Alt-Tab, native dialog) keeps the radio.
        onBlur={(e) => {
          if (e.relatedTarget === null && !document.hasFocus()) return
          setFocusedLevel(null)
        }}
        onValueChange={(value) => {
          if (value === INHERIT_VALUE) pick(INHERIT_VALUE)
          // Write an `auto`/`max` token back only while it is still stored, never from the kept-focused radio (#1127).
          else if (hasValue && !unresolvedModel && (KNOWN_LEVELS.has(value) || value === storedLevel)) pick(value)
          else if (hasValue && !unresolvedModel) announcePolite(`${roleLabel} reasoning: ${UNKNOWN_LEVEL_LABEL[value] ?? value} is no longer set for this model`)
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
            unavailable={unknownLevelToShow !== storedOrCurrentUnknown}
            pending={disabled && currentLevel === unknownLevelToShow}
          />
        )}
      </RadioGroup>
      {disabled && (
        // Sits under the row the radio user just picked in; the Select has its own cue.
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
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
  pending,
  unavailable = false
}: {
  id: string
  value: string
  label: string
  disabled: boolean
  pending: boolean
  /** Kept mounted only to hold keyboard focus (never natively `disabled`, which would drop it). */
  unavailable?: boolean
}) {
  return (
    <RadioGroupItem
      id={id}
      value={value}
      disabled={disabled}
      aria-disabled={unavailable || undefined}
      className={cn(
        'min-h-6 w-auto flex-row items-center gap-2 rounded-none border-none bg-transparent px-0 py-0 text-xs font-normal hover:bg-transparent focus-visible:ring-2 data-[state=checked]:border-none disabled:cursor-not-allowed disabled:opacity-50',
        COMPOSER_DISABLED_OPACITY_CLASS,
        // Plain `bg-accent/70` ties with the base checked transparent bg and loses; use a mutually exclusive checked variant.
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
