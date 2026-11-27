// Issue #1758: where a tool row shows its target (path, command, pattern, URL). Applies live; the shared segmented `ToggleGroup`.
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow } from '@/components/settings/SettingRow'
import { useSettingsStore } from '@/state'
import { DEFAULT_TRANSCRIPT_DISPLAY, TOOL_TARGETS_VALUES, type ToolTargets } from '../../../shared/transcriptDisplay'

const LABELS: Record<ToolTargets, string> = { hide: 'Hide', hover: 'Hover', show: 'Show' }

export function ToolTargetsRow() {
  const value = useSettingsStore((state) => state.settings.transcriptDisplay?.toolTargets ?? DEFAULT_TRANSCRIPT_DISPLAY.toolTargets)
  const setToolTargets = useSettingsStore((state) => state.setToolTargets)
  return (
    <SettingRow
      id="transcript-display-tool-targets"
      label="Tool targets"
      labelAsText
      description="The file, command or pattern a tool row acts on. Hover shows it in the row's tooltip, Show puts it in the row, Hide leaves it to the full call view."
    >
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          // Radix emits '' when the selected segment is clicked again; keep one selected.
          const picked = TOOL_TARGETS_VALUES.find((option) => option === next)
          if (picked) void setToolTargets(picked)
        }}
        size="sm"
        aria-labelledby="transcript-display-tool-targets-label"
        aria-describedby="transcript-display-tool-targets-description"
      >
        {TOOL_TARGETS_VALUES.map((option) => (
          <ToggleGroupItem key={option} value={option}>
            {LABELS[option]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SettingRow>
  )
}
