// Issue #1300: Settings > Appearance > Chat row spacing. The gap between consecutive activity rows
// in the transcript; applies live, no Save step. The shared segmented `ToggleGroup`, as Activity text.
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingRow } from '@/components/settings/SettingRow'
import { useSettingsStore } from '@/state'
import { DEFAULT_CHAT_ROW_DENSITY, type ChatRowDensity } from '../../../shared/chatRowDensity'

const OPTIONS: ReadonlyArray<{ value: ChatRowDensity; label: string }> = [
  { value: 'tight', label: 'Tight' },
  { value: 'compact', label: 'Compact' },
  { value: 'comfy', label: 'Comfy' }
]

export function ChatRowSpacingGroup() {
  const density = useSettingsStore((state) => state.settings.chatRowDensity ?? DEFAULT_CHAT_ROW_DENSITY)
  const setChatRowDensity = useSettingsStore((state) => state.setChatRowDensity)
  return (
    <SettingsGroup title="Chat row spacing">
      <SettingRow
        id="chat-row-density"
        label="Spacing"
        labelAsText
        description="Space between activity lines in the chat. Compact is the default."
      >
        <ToggleGroup
          type="single"
          value={density}
          onValueChange={(value) => {
            // Radix emits '' when the selected segment is clicked again; keep one selected.
            const next = OPTIONS.find((option) => option.value === value)
            if (next) void setChatRowDensity(next.value)
          }}
          size="sm"
          aria-labelledby="chat-row-density-label"
          aria-describedby="chat-row-density-description"
        >
          {OPTIONS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
    </SettingsGroup>
  )
}
