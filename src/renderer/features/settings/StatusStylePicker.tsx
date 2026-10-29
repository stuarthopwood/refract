import { useId } from 'react'
import { RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { StatusStylePreview } from '@/components/StatusStylePreview'
import { useSettingsStore } from '@/state'
import type { StatusStyle } from '../../../shared/statusStyle'

const OPTIONS: ReadonlyArray<{ id: StatusStyle; name: string; description: string }> = [
  { id: 'icons', name: 'Icons', description: 'Default. A distinct glyph per state.' },
  { id: 'dots', name: 'Dots', description: 'A distinct dot shape per state.' }
]

/** Issue #482: the Appearance "Status style" radio group; applies live, no Save/Cancel. Each
 * option carries its own preview, so choosing is a look-then-pick. */
export function StatusStylePicker({ labelledBy, describedBy }: { labelledBy: string; describedBy: string }) {
  const current = useSettingsStore((state) => state.settings.statusStyle ?? 'icons')
  const setStatusStyle = useSettingsStore((state) => state.setStatusStyle)
  const baseId = useId()
  return (
    <RadioGroup
      value={current}
      onValueChange={(value) => void setStatusStyle(value as StatusStyle)}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {OPTIONS.map((option) => (
        <RadioGroupItem
          key={option.id}
          value={option.id}
          aria-labelledby={`${baseId}-${option.id}-name`}
          aria-describedby={`${baseId}-${option.id}-description`}
        >
          <span className="flex items-center gap-2">
            <span className={RADIO_RING_CLASS} aria-hidden>
              <RadioGroupIndicator />
            </span>
            <span id={`${baseId}-${option.id}-name`} className="font-medium">
              {option.name}
            </span>
            <span id={`${baseId}-${option.id}-description`} className="text-xs text-muted-foreground">
              {option.description}
            </span>
          </span>
          <StatusStylePreview style={option.id} />
        </RadioGroupItem>
      ))}
    </RadioGroup>
  )
}
