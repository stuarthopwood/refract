// The shared "any or one of" select (ADR 0003): a compact select whose first item clears the
// filter. Radix Select forbids an empty-string item value, so "any" gets a sentinel. The Usage
// view's Project, model, reasoning and agent filters use it.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const ANY = '__any__'

export interface OptionSelectProps {
  /** Accessible name of the trigger. */
  label: string
  /** Text of the item (and the trigger) when nothing is chosen, for example "All models". */
  anyLabel: string
  value: string | null | undefined
  options: string[]
  /** Display text for an option whose stored value is not fit to show (for example `main`). */
  optionLabel?(option: string): string
  onChange(value: string | null): void
  className?: string
}

export function OptionSelect({ label, anyLabel, value, options, optionLabel, onChange, className }: OptionSelectProps) {
  return (
    <Select value={value ?? ANY} onValueChange={(next) => onChange(next === ANY ? null : next)}>
      <SelectTrigger aria-label={label} className={className ?? 'min-w-0 max-w-44'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{anyLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {optionLabel ? optionLabel(option) : option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
