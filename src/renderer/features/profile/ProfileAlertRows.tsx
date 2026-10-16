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
// whether it was already showing on the previous render, and the announce effect below only
// fires on a hidden -> shown transition.
//
// Quality-gate remediation (round 1, four reviewers): this component is mounted inside App.tsx's
// collapsible nav column (`inert`/`aria-hidden` while `navCollapsed`), so a LOCAL `aria-live`
// region here is silenced whenever the nav is collapsed -- a screen reader would never hear an
// alert that first appears in that state. Announcements now go through `useChatAreaAnnouncer`
// (the same always-mounted, never-hidden app-level region `quickCreateFallback.ts` already uses
// from outside a component), not a local `useClearedAnnouncement` region. The two conditions can
// also both become true in the SAME commit (e.g. on first mount, if a low-memory warning has
// already arrived by the time the omp-version warning is set) -- announcing them from two
// separate effects would race (`announce()` clears the other's still-pending text), so one
// effect below watches both and joins them into a single announcement when both transition
// together.
import { useEffect, useRef, useState } from 'react'
import { focusProfileItemName } from '@/lib/focus'
import { AlertTriangleIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useHealthStore, useMemoryStore } from '@/state'
import { HealthCheckDialog } from './HealthCheckDialog'
import { MemoryTriageDialog } from './MemoryTriageDialog'

/** Matches the retired StatusBar.tsx's own `pluralAgents` exactly (never "1 agents"). */
function pluralAgents(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'}`
}


export function ProfileAlertRows() {
  const warning = useMemoryStore((state) => state.warning)
  const ompVersionWarning = useHealthStore((state) => state.ompVersionWarning)
  const [dismissed, setDismissed] = useState({ memory: false, ompVersion: false })
  const [triageOpen, setTriageOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const triageButtonRef = useRef<HTMLButtonElement>(null)
  const checkButtonRef = useRef<HTMLButtonElement>(null)

  const memoryShown = warning !== null && !dismissed.memory
  const ompVersionShown = ompVersionWarning !== null && !dismissed.ompVersion

  const wasMemoryShown = useRef(false)
  const wasOmpVersionShown = useRef(false)
  useEffect(() => {
    const memoryJustShown = memoryShown && !wasMemoryShown.current
    const ompVersionJustShown = ompVersionShown && !wasOmpVersionShown.current
    const memoryText = `Low memory: ${pluralAgents(warning?.liveAgents ?? 0)} running`
    const ompVersionText = ompVersionWarning ? `omp ${ompVersionWarning.found} is an unverified version` : ''
    if (memoryJustShown && ompVersionJustShown) {
      useChatAreaAnnouncer.getState().announce(`${memoryText}. ${ompVersionText}`)
    } else if (memoryJustShown) {
      useChatAreaAnnouncer.getState().announce(memoryText)
    } else if (ompVersionJustShown) {
      useChatAreaAnnouncer.getState().announce(ompVersionText)
    }
    wasMemoryShown.current = memoryShown
    wasOmpVersionShown.current = ompVersionShown
  }, [memoryShown, ompVersionShown, warning?.liveAgents, ompVersionWarning])

  return (
    <div className={memoryShown || ompVersionShown ? 'flex flex-col gap-0.5 px-2 pb-2' : 'flex flex-col gap-0.5'}>
      {memoryShown && warning && (
        <div className="flex h-6 items-center gap-1.5 text-xs text-state-needs-you">
          <AlertTriangleIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Low memory ({pluralAgents(warning.liveAgents)})</span>
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
        onCloseFocus={() => {
          if (triageButtonRef.current?.isConnected) triageButtonRef.current.focus()
          else focusProfileItemName()
        }}
      />
      <HealthCheckDialog
        open={healthOpen}
        onOpenChange={setHealthOpen}
        onCloseFocus={() => {
          if (checkButtonRef.current?.isConnected) checkButtonRef.current.focus()
          else focusProfileItemName()
        }}
      />
    </div>
  )
}
