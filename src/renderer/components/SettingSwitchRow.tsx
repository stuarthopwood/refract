// One labelled Settings switch row (ADR 0003, reusable components): a label, a muted description
// wired to the switch through `aria-describedby`, and the switch itself on the right. Shared by
// the Settings sections instead of each repeating the same markup.
import { SettingFieldRow } from '@/components/SettingFieldRow'
import { Switch } from '@/components/ui/switch'

interface SettingSwitchRowProps {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function SettingSwitchRow({ id, label, description, checked, onCheckedChange }: SettingSwitchRowProps) {
  return (
    <SettingFieldRow id={id} label={label} description={description}>
      <Switch id={id} aria-describedby={`${id}-description`} checked={checked} onCheckedChange={onCheckedChange} />
    </SettingFieldRow>
  )
}