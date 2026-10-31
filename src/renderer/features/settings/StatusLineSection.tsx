// Settings > Status line (formerly "Session readout", spec 004 FR-011 to FR-016): which readouts
// show in the chip row above the message box, and the current-work line. Each row carries the
// readout's own icon from the shared `READOUT_KIND_ICONS` map.
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { READOUT_KIND_ICONS } from '@/components/icons/readout-icons'
import { useSettingsStore } from '@/state'
import type { ReadoutKind } from '../../../shared/model'

interface ReadoutToggleDescriptor {
  kind: ReadoutKind
  label: string
  description: string
}

// FR-012: every ReadoutKind, in the chip row's own order.
const CHIP_TOGGLES: ReadoutToggleDescriptor[] = [
  { kind: 'changes', label: 'Changes', description: "Files changed and lines added or removed against the Base branch." },
  {
    kind: 'context-usage',
    label: 'Context window usage',
    description: "Tokens used out of the model's context window, with a warning once it nears the limit."
  },
  { kind: 'turn-time', label: 'Turn time', description: 'Elapsed time while a turn is running.' },
  { kind: 'current-time', label: 'Current time', description: 'The current time of day, updating at the top of each minute.' },
  { kind: 'subagents', label: 'Subagents', description: 'How many subagents are running or finished for the current turn.' },
  { kind: 'todo-progress', label: 'Todo progress', description: "How many of the agent's current tasks are done." }
]

const CURRENT_WORK_TOGGLE: ReadoutToggleDescriptor = {
  kind: 'current-work',
  label: 'Show current work above the composer',
  description: 'A one-line banner of what the agent is doing while a turn runs or it needs you.'
}

export function StatusLineSection() {
  const sessionReadout = useSettingsStore((state) => state.settings.sessionReadout)
  const setReadoutVisibility = useSettingsStore((state) => state.setReadoutVisibility)

  function renderToggle(toggle: ReadoutToggleDescriptor) {
    return (
      <SettingSwitchRow
        key={toggle.kind}
        id={`readout-toggle-${toggle.kind}`}
        label={toggle.label}
        description={toggle.description}
        icon={READOUT_KIND_ICONS[toggle.kind]}
        checked={sessionReadout[toggle.kind]}
        onCheckedChange={(checked) => void setReadoutVisibility(toggle.kind, checked)}
      />
    )
  }

  return (
    <SettingsPage
      title="Status line"
      intro="Choose which readouts show in the chip row above the message box, and whether the current-work line shows above it, for every open Session."
    >
      <SettingsGroup title="Chip row">{CHIP_TOGGLES.map(renderToggle)}</SettingsGroup>
      <SettingsGroup title="Current work">{renderToggle(CURRENT_WORK_TOGGLE)}</SettingsGroup>
    </SettingsPage>
  )
}
