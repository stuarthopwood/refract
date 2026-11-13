// Issue #1205 (FR-107): Settings > Sessions. "Show the Agent stopped bar" only hides the bar
// above the composer (`AgentStoppedBar.tsx`); a stopped Session still always opens history-only.
import { useEffect } from 'react'
import { GhStackNotice } from '@/components/GhStackNotice'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { useSettingsStore } from '@/state'
import { useGhStackStore } from '@/state/gh-stack-store'

export function SessionsSection() {
  const showAgentStoppedBar = useSettingsStore((state) => state.settings.showAgentStoppedBar !== false)
  const setShowAgentStoppedBar = useSettingsStore((state) => state.setShowAgentStoppedBar)
  const stackedPullRequests = useSettingsStore((state) => state.settings.stackedPullRequests !== false)
  const setStackedPullRequests = useSettingsStore((state) => state.setStackedPullRequests)
  // Re-probed each time Settings opens, so an extension installed outside Refract shows as ready.
  useEffect(() => {
    void useGhStackStore.getState().load()
  }, [])

  return (
    <SettingsPage title="Sessions" intro="Opening a stopped Session shows its saved history without starting the agent.">
      <SettingsGroup title="Agent stopped bar">
        <SettingSwitchRow
          id="show-agent-stopped-bar-toggle"
          label="Show the Agent stopped bar"
          description="A bar above the message box with Start agent. Off hides it; sending a message still starts the agent."
          checked={showAgentStoppedBar}
          onCheckedChange={(checked) => void setShowAgentStoppedBar(checked)}
        />
      </SettingsGroup>
      <SettingsGroup title="Stacked pull requests">
        <SettingSwitchRow
          id="stacked-pull-requests-toggle"
          label="Use stacked pull requests"
          description={
            <span className="flex flex-col gap-1">
              <span>Sessions open pull requests with gh stack, and Merge merges a stack together. Needs the gh-stack extension.</span>
              <GhStackNotice layout="inline" />
            </span>
          }
          checked={stackedPullRequests}
          onCheckedChange={(checked) => void setStackedPullRequests(checked)}
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
