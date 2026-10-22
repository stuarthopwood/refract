// One labelled Settings switch row (ADR 0003, reusable components): a label, a muted description
// wired to the switch through `aria-describedby`, and the switch itself on the right. Shared by
// the Settings sections instead of each repeating the same markup.
import { Switch } from '@/components/ui/switch'

interface SettingSwitchRowProps {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function SettingSwitchRow({ id, label, description, checked, onCheckedChange }: SettingSwitchRowProps) {
  const descriptionId = `${id}-description`
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </span>
      </div>
      <Switch id={id} aria-describedby={descriptionId} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
