// #1409 (spec 070): the one-time Session notice shown when a WATCHDOG.yml roster was found at
// launch, because a roster silently replaces the Advisor role. Refract never deletes the file.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { PaneBanner } from '@/components/PaneBanner'
import { Button } from '@/components/ui/button'
import { focusSessionPane } from '@/lib/focus'
import { useAdvisorRosterStore } from '@/state/advisor-roster-store'
import { describeAdvisorRoster } from '../../../shared/ipc-advisor-roster'

export function AdvisorRosterNotice({ sessionId }: { sessionId: string }) {
  const roster = useAdvisorRosterStore((s) => s.bySession[sessionId])
  const dismissedPath = useAdvisorRosterStore((s) => s.dismissed[sessionId])
  const hasRoster = Boolean(roster)
  // A renderer reload loses the launch-time event; ask the backend once for a Session with no roster in the store.
  useEffect(() => {
    if (hasRoster) return
    void window.refract.advisorRoster
      .detect(sessionId)
      .then((result) => {
        if (result.ok && result.value) useAdvisorRosterStore.getState().setDetected({ sessionId, roster: result.value })
      })
      .catch(() => {}) // a bridge rejection must not become an unhandled rejection
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount; a later roster arrives by event
  }, [sessionId])
  if (!roster || dismissedPath === roster.path) return null
  const rosterPath = roster.path

  async function open() {
    const result = await window.refract.advisorRoster.open(sessionId)
    if (!result.ok) toast.error(`Could not open the roster file: ${result.error.message}`)
  }

  async function copyPath() {
    const result = await window.refract.clipboard.writeText(rosterPath)
    if (result.ok) toast.success('Path copied')
    else toast.error(`Could not copy the path: ${result.error.message}`)
  }

  return (
    <PaneBanner
      role="region"
      aria-label="Advisor roster"
      severity="warning"
      title={describeAdvisorRoster(roster)}
      detail={`File: ${roster.path}`}
      data-slot="advisor-roster-notice"
      className="shrink-0 px-4 py-2"
    >
      <Button type="button" variant="outline" size="xs" onClick={() => void open()}>
        Open file
      </Button>
      <Button type="button" variant="text" size="xs" onClick={() => void copyPath()}>
        Copy path
      </Button>
      <Button
        type="button"
        variant="text"
        size="xs"
        onClick={() => {
          useAdvisorRosterStore.getState().dismiss(sessionId)
          focusSessionPane(sessionId)
        }}
      >
        Dismiss
      </Button>
    </PaneBanner>
  )
}
