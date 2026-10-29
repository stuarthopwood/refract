import { RADIO_RING_CLASS, RadioGroup, RadioGroupIndicator, RadioGroupItem } from '@/components/ui/radio-group'
import { StateIcon, STATUS_LABEL } from '@/features/sessions/sessionDisplay'
import type { SessionDisplayStatus } from '@/features/sessions/sessionDisplay'
import { useSettingsStore } from '@/state'
import type { StatusStyle } from '../../../shared/statusStyle'

const STATES: readonly SessionDisplayStatus[] = ['idle', 'working', 'needs-you', 'stopped', 'unread-response']

const OPTIONS: ReadonlyArray<{ id: StatusStyle; name: string; description: string }> = [
  { id: 'icons', name: 'Icons', description: 'Default. A distinct glyph per state.' },
  { id: 'dots', name: 'Dots', description: 'A distinct dot shape per state.' }
]

/** Issue #482: all five Session states drawn in one Status style, in the active theme. Reusable
 * wherever a style needs showing; each state's word is visible, so nothing relies on colour. */
export function StatusStylePreview({ style }: { style: StatusStyle }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {STATES.map((state) => (
        <li key={state} className="flex items-center gap-1.5">
          <StateIcon status={state} style={style} />
          {STATUS_LABEL[state]}
        </li>
      ))}
    </ul>
  )
}

/** Issue #482: the Appearance "Status style" radio group; applies live, no Save/Cancel. Each
 * option carries its own preview, so choosing is a look-then-pick. */
export function StatusStylePicker({ labelledBy, describedBy }: { labelledBy: string; describedBy: string }) {
  const current = useSettingsStore((state) => state.settings.statusStyle ?? 'icons')
  const setStatusStyle = useSettingsStore((state) => state.setStatusStyle)
  return (
    <RadioGroup
      value={current}
      onValueChange={(value) => void setStatusStyle(value as StatusStyle)}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {OPTIONS.map((option) => (
        <RadioGroupItem key={option.id} value={option.id} aria-label={option.name}>
          <span className="flex items-center gap-2">
            <span className={RADIO_RING_CLASS} aria-hidden>
              <RadioGroupIndicator />
            </span>
            <span className="font-medium">{option.name}</span>
            <span className="text-xs text-muted-foreground">{option.description}</span>
          </span>
          <StatusStylePreview style={option.id} />
        </RadioGroupItem>
      ))}
    </RadioGroup>
  )
}
