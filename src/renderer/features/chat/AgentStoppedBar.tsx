// Issue #1205 (FR-105, FR-107): the quiet "Agent stopped" bar directly above the composer, shown
// while the shown Session's agent is stopped and no FR-034/FR-035 stop banner applies (that
// banner replaces it; `ChatPane.tsx` passes `allowed` false then, and while a start is running).
// Plain text, never colour alone, and `role="region"` rather than a live region, so opening a
// stopped Session announces nothing extra. **Start agent** is the explicit start (FR-104).
import { toast } from 'sonner'
import { PaneBanner } from '@/components/PaneBanner'
import { Button } from '@/components/ui/button'
import { focusSessionPane } from '@/lib/focus'
import { useSessionsStore, useSettingsStore, useSplitStore } from '@/state'

export function AgentStoppedBar({ sessionId, allowed }: { sessionId: string; allowed: boolean }) {
  const stopped = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status === 'stopped')
  const enabled = useSettingsStore((s) => s.settings.showAgentStoppedBar !== false)
  const setShowAgentStoppedBar = useSettingsStore((s) => s.setShowAgentStoppedBar)

  const sessionName = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.name ?? 'Session')

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
    <PaneBanner
      role="region"
      aria-label={`Agent stopped: ${sessionName}`}
      severity="warning"
      title="Agent stopped"
      data-slot="agent-stopped-bar"
      className="shrink-0 px-4 py-2"
    >
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={`Start agent for ${sessionName}`}
        onClick={handleStart}
      >
        Start agent
      </Button>
      <Button
        type="button"
        variant="text"
        size="xs"
        className="text-muted-foreground underline underline-offset-2 hover:decoration-2"
        aria-label={`Don't show again, ${sessionName}`}
        onClick={() => void handleDontShowAgain()}
      >
        Don't show again
      </Button>
    </PaneBanner>
  )
}
