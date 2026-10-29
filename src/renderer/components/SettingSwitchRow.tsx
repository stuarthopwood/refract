// One labelled Settings switch row (ADR 0003, reusable components): a label, a muted description
// wired to the switch through `aria-describedby`, and the switch itself on the right. Shared by
// the Settings sections instead of each repeating the same markup.
import { SettingRow } from '@/components/settings/SettingRow'
import type { SettingIcon } from '@/components/settings/SettingRow'
import { Switch } from '@/components/ui/switch'

interface SettingSwitchRowProps {
  id: string
  label: string
  description: string
  checked: boolean
  icon?: SettingIcon
  onCheckedChange: (checked: boolean) => void
}

export function SettingSwitchRow({ id, label, description, checked, icon, onCheckedChange }: SettingSwitchRowProps) {
  return (
    <SettingRow id={id} label={label} description={description} icon={icon}>
      <Switch id={id} aria-describedby={`${id}-description`} checked={checked} onCheckedChange={onCheckedChange} />
    </SettingRow>
  )
}
