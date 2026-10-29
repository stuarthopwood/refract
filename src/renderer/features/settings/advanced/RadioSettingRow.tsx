// An enum Settings row as a radio group inside a `fieldset` with a `legend` (Settings > Advanced).
import type { ReactNode } from 'react'
import { SettingRow } from '@/components/settings/SettingRow'
import { RADIO_DOT_CLASS, RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import type { TokenGuardOption } from '../../../../shared/tokenGuard'

interface RadioSettingRowProps {
  id: string
  label: string
  description: ReactNode
  options: readonly TokenGuardOption[]
  value: string
  actions?: ReactNode
  disabled?: boolean
  describedBy?: string
  note?: ReactNode
  onChange: (value: string) => void
}

export function RadioSettingRow({ id, label, description, options, value, actions, disabled, describedBy, note, onChange }: RadioSettingRowProps) {
  return (
    <SettingRow id={id} label={label} description={description} note={note} labelAsText disabled={disabled}>
      <fieldset
        className="flex flex-wrap items-center gap-x-4 gap-y-2"
        disabled={disabled}
        aria-describedby={describedBy ?? `${id}-description`}
      >
        <legend className="sr-only">{label}</legend>
        <RadioGroup
          aria-labelledby={`${id}-label`}
          orientation="horizontal"
          className="flex-row flex-wrap gap-x-4"
          value={value}
          disabled={disabled}
          onValueChange={onChange}
        >
          {options.map((option) => (
            <RadioGroupItem
              key={option.value}
              id={`${id}-${option.value}`}
              value={option.value}
              disabled={disabled}
              aria-describedby={describedBy}
              className="min-h-6 w-auto flex-row items-center gap-2 rounded-none border-none bg-transparent px-0 py-0 text-sm hover:bg-transparent data-[state=checked]:border-none data-[state=checked]:bg-transparent"
            >
              <span aria-hidden className={RADIO_RING_CLASS}>
                <RadioGroupIndicator className={RADIO_DOT_CLASS} />
              </span>
              {option.label}
            </RadioGroupItem>
          ))}
        </RadioGroup>
        {actions}
      </fieldset>
    </SettingRow>
  )
}
