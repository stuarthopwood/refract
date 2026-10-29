// Issue #1205 (FR-107): Settings > Sessions. "Show the Agent stopped bar" only hides the bar
// above the composer (`AgentStoppedBar.tsx`); a stopped Session still always opens history-only.
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { useSettingsStore } from '@/state'

export function SessionsSection() {
  const showAgentStoppedBar = useSettingsStore((state) => state.settings.showAgentStoppedBar !== false)
  const setShowAgentStoppedBar = useSettingsStore((state) => state.setShowAgentStoppedBar)

  return (
    <SettingsPage title="Sessions" intro="Opening a stopped Session shows its saved history without starting the agent.">
      <SettingsGroup title="Stopped Sessions">
        <SettingSwitchRow
          id="show-agent-stopped-bar-toggle"
          label="Show the Agent stopped bar"
          description="A bar above the message box with Start agent. Off hides it; sending a message still starts the agent."
          checked={showAgentStoppedBar}
          onCheckedChange={(checked) => void setShowAgentStoppedBar(checked)}
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
