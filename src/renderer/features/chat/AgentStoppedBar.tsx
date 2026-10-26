// Issue #1205 (FR-105, FR-107): the quiet "Agent stopped" bar directly above the composer, shown
// while the shown Session's agent is stopped and no FR-034/FR-035 stop banner applies (that
// banner replaces it; `ChatPane.tsx` passes `allowed` false then, and while a start is running).
// Plain text, never colour alone, and `role="region"` rather than a live region, so opening a
// stopped Session announces nothing extra. **Start agent** is the explicit start (FR-104).
import { toast } from 'sonner'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { focusSessionPane } from '@/lib/focus'
import { useSessionsStore, useSettingsStore, useSplitStore } from '@/state'

export function AgentStoppedBar({ sessionId, allowed }: { sessionId: string; allowed: boolean }) {
  const stopped = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status === 'stopped')
  const enabled = useSettingsStore((s) => s.settings.showAgentStoppedBar !== false)
  const setShowAgentStoppedBar = useSettingsStore((s) => s.setShowAgentStoppedBar)

  if (!allowed || !stopped || !enabled) return null

  async function handleDontShowAgain() {
    if (!(await setShowAgentStoppedBar(false))) return
    focusSessionPane(sessionId)
    toast.success('The Agent stopped bar is hidden. Turn it back on in Settings > Sessions.', {
      duration: 10000,
      action: { label: 'Undo', onClick: () => void setShowAgentStoppedBar(true) }
    })
  }

  // The bar unmounts as the start begins; focus moves to the composer rather than <body>.
  function handleStart() {
    useSplitStore.getState().markOpened(sessionId)
    void useSessionsStore.getState().open(sessionId, true)
    requestAnimationFrame(() => focusSessionPane(sessionId))
  }

  return (
    <Alert
      role="region"
      aria-label="Agent stopped"
      box="inline"
      data-slot="agent-stopped-bar"
      className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground"
    >
      <span>Agent stopped</span>
      <Button type="button" variant="outline" size="xs" onClick={handleStart}>
        Start agent
      </Button>
      <Button type="button" variant="link" size="xs" className="text-muted-foreground" onClick={() => void handleDontShowAgain()}>
        Don't show again
      </Button>
    </Alert>
  )
}
