// Issue #1205 (FR-107): Settings > Sessions. "Show the Agent stopped bar" only hides the bar
// above the composer (`AgentStoppedBar.tsx`); a stopped Session still always opens history-only.
import { useEffect, useRef } from 'react'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { useSettingsStore } from '@/state'

export function SessionsSection() {
  const showAgentStoppedBar = useSettingsStore((state) => state.settings.showAgentStoppedBar !== false)
  const setShowAgentStoppedBar = useSettingsStore((state) => state.setShowAgentStoppedBar)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Sessions
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Opening a stopped Session shows its saved history without starting the agent.
      </p>
      <SettingSwitchRow
        id="show-agent-stopped-bar-toggle"
        label="Show the Agent stopped bar"
        description="A bar above the message box with Start agent. Off hides it; sending a message still starts the agent."
        checked={showAgentStoppedBar}
        onCheckedChange={(checked) => void setShowAgentStoppedBar(checked)}
      />
    </div>
  )
}
