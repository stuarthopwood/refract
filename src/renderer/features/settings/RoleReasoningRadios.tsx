// Issue #1069 decision 4: one reasoning-level radio group per CHAT role (never shown for the 5
// model-kind roles, decision 6). Uses the Radix-backed primitives plus the shared contrast-fixed
// ring/dot class strings from #1043/PR #1057 (`RADIO_RING_CLASS`/`RADIO_DOT_CLASS`), matching
// `AskCard.tsx`/`MergeDialog.tsx`'s structure but NOT either file's own older inline ring
// (`border-primary`, which measures under 3:1 in three themes -- `radio-group.tsx`'s own header).
import { RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { RADIO_DOT_CLASS, RADIO_RING_CLASS } from '@/components/ui/radio-group'
import type { ModelCatalogEntry } from '../../../shared/model'
import { splitThinkingSuffix } from './modelRoleSuffix'

type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
const INHERIT_VALUE = 'inherit'

// Decision 4's exact seven options; `xhigh` is the suffix vocabulary's own token for "Extra
// high" (`modelRoleSuffix.ts`'s `THINKING_SUFFIX_RE`). `off`/`auto`/`max` also exist in that
// vocabulary but `auto`/`max` are not part of this seven-option UI.
const LEVELS: ReadonlyArray<{ value: ReasoningLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' }
]

export interface RoleReasoningRadiosProps {
  /** `ModelRoleId`, used only to build each option's own DOM id -- kept as a plain string so this
   * component never needs the shared model types just for an id prefix. */
  role: string
  /** The role's own visible label element id (`aria-labelledby`): a named radiogroup per role,
   * never a second generic "Reasoning" name repeated across all ten (accessibility section). */
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
}

/** Decision 4: Inherit is always enabled (it writes no suffix); every other level is enabled only
 * when the role's chosen model itself supports it (`reasoning`/`thinking`, confirmed present in
 * `omp models --kind chat --json`) -- a disabled item carries a reason, never a silently-greyed
 * option with no explanation. */
export function RoleReasoningRadios({ role, labelId, currentValue, catalogEntry, disabled, onPick }: RoleReasoningRadiosProps) {
  const { base, suffix } = currentValue ? splitThinkingSuffix(currentValue) : { base: '', suffix: null }
  const currentLevel = suffix ? suffix.slice(1) : INHERIT_VALUE // ':high' -> 'high'
  const noModel = currentValue === undefined || !catalogEntry

  function disabledReason(level: ReasoningLevel): string | null {
    if (noModel) return 'Pick a model first'
    const supported = level === 'off' ? catalogEntry.reasoning : (catalogEntry.thinking?.includes(level) ?? false)
    return supported ? null : `Not supported by ${catalogEntry.name}`
  }

  return (
    <RadioGroup
      aria-labelledby={labelId}
      className="mt-2 flex flex-row flex-wrap gap-x-4 gap-y-1.5"
      value={currentLevel}
      onValueChange={(value) => {
        if (disabled) return
        if (value === INHERIT_VALUE) onPick(base)
        else if (!noModel) onPick(`${base}:${value}`)
      }}
    >
      <ReasoningRadioItem id={`model-role-${role}-reasoning-inherit`} value={INHERIT_VALUE} label="Inherit" disabled={disabled} />
      {LEVELS.map(({ value, label }) => {
        const reason = disabledReason(value)
        return (
          <ReasoningRadioItem
            key={value}
            id={`model-role-${role}-reasoning-${value}`}
            value={value}
            label={label}
            disabled={disabled || reason !== null}
            reason={reason}
          />
        )
      })}
    </RadioGroup>
  )
}

function ReasoningRadioItem({
  id,
  value,
  label,
  disabled,
  reason
}: {
  id: string
  value: string
  label: string
  disabled: boolean
  reason?: string | null
}) {
  const reasonId = reason ? `${id}-reason` : undefined
  return (
    <RadioGroupItem
      id={id}
      value={value}
      disabled={disabled}
      aria-describedby={reasonId}
      className="w-auto flex-row items-center gap-1.5 rounded-none border-none bg-transparent px-0 py-0 text-xs font-normal hover:bg-transparent focus-visible:ring-2 data-[state=checked]:border-none data-[state=checked]:bg-transparent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span aria-hidden className={RADIO_RING_CLASS}>
        <RadioGroupIndicator className={RADIO_DOT_CLASS} />
      </span>
      {label}
      {reason && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </RadioGroupItem>
  )
}
