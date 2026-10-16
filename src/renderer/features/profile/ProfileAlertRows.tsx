// Quiet alert rows (issue #560, spec 001 FR-037/FR-072; spec 008 FR-029): two single-line
// notices rendered as App.tsx siblings directly after <ProfileItem/>, in the session-list
// column's own 'flex h-full flex-col' wrapper (SessionList.tsx:397-400, #567 decision 20,
// already reserved this render order). Replaces StatusBar.tsx's own low-memory and omp-version
// Popovers -- the footer (StatusBar.tsx) keeps only its update-availability badge.
//
// Each row: an icon, short text, one text action, and a small dismiss control. Dismissal is a
// plain local boolean per alert, never persisted and never read from any store -- a restart
// remounts this component with both flags false again, satisfying "the alert returns if the
// condition persists after a restart" with no extra logic. "Announced once" means once per
// appearance (including a post-dismiss recurrence after a restart): a ref per alert tracks
// whether it was already showing on the previous render, and announce() only fires on a
// hidden -> shown transition.
import { useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useHealthStore, useMemoryStore } from '@/state'
import { HealthCheckDialog } from './HealthCheckDialog'
import { MemoryTriageDialog } from './MemoryTriageDialog'

export function ProfileAlertRows() {
  const warning = useMemoryStore((state) => state.warning)
  const ompVersionWarning = useHealthStore((state) => state.ompVersionWarning)
  const [dismissed, setDismissed] = useState({ memory: false, ompVersion: false })
  const [triageOpen, setTriageOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [announcement, announce] = useClearedAnnouncement()
  const triageButtonRef = useRef<HTMLButtonElement>(null)
  const checkButtonRef = useRef<HTMLButtonElement>(null)

  const memoryShown = warning !== null && !dismissed.memory
  const ompVersionShown = ompVersionWarning !== null && !dismissed.ompVersion

  const wasMemoryShown = useRef(false)
  useEffect(() => {
    if (memoryShown && !wasMemoryShown.current) {
      announce(`Low memory: ${warning?.liveAgents ?? 0} agents running`)
    }
    wasMemoryShown.current = memoryShown
  }, [memoryShown, warning?.liveAgents, announce])

  const wasOmpVersionShown = useRef(false)
  useEffect(() => {
    if (ompVersionShown && !wasOmpVersionShown.current && ompVersionWarning) {
      announce(`omp ${ompVersionWarning.found} is an unverified version`)
    }
    wasOmpVersionShown.current = ompVersionShown
  }, [ompVersionShown, ompVersionWarning, announce])

  return (
    <div className="flex flex-col gap-0.5 px-2 pb-2 empty:p-0">
      {memoryShown && warning && (
        <div className="flex h-6 items-center gap-1.5 text-xs text-state-needs-you">
          <AlertTriangleIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Low memory ({warning.liveAgents} agents)</span>
          <Button
            ref={triageButtonRef}
            type="button"
            variant="link"
            size="xs"
            aria-label="Open memory triage"
            className="h-auto p-0 text-state-needs-you"
            onClick={() => setTriageOpen(true)}
          >
            Triage
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss low memory alert"
            className="text-state-needs-you hover:text-state-needs-you"
            onClick={() => setDismissed((current) => ({ ...current, memory: true }))}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      )}
      {ompVersionShown && ompVersionWarning && (
        <div className="flex h-6 items-center gap-1.5 text-xs text-state-needs-you">
          <AlertTriangleIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">omp {ompVersionWarning.found}: unverified version</span>
          <Button
            ref={checkButtonRef}
            type="button"
            variant="link"
            size="xs"
            aria-label="Open Health check"
            className="h-auto p-0 text-state-needs-you"
            onClick={() => setHealthOpen(true)}
          >
            Check
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss unverified version alert"
            className="text-state-needs-you hover:text-state-needs-you"
            onClick={() => setDismissed((current) => ({ ...current, ompVersion: true }))}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      )}
      <MemoryTriageDialog
        open={triageOpen}
        onOpenChange={setTriageOpen}
        onCloseFocus={() => triageButtonRef.current?.focus()}
      />
      <HealthCheckDialog
        open={healthOpen}
        onOpenChange={setHealthOpen}
        onCloseFocus={() => checkButtonRef.current?.focus()}
      />
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
