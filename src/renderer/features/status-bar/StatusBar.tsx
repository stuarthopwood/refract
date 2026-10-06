// Status bar (docs/DESIGN.md "Layout"): the T039 low-memory notice (contracts/ipc.md
// `memory:warning`, FR-037), the omp-version notice (readiness.ts, health-store.ts), and (spec
// 006, research.md decision 11) the update badge are the always-visible controls here. The
// update badge is pinned to the RIGHT side of this bar (quality-gate remediation, UI Medium:
// previously grouped with the left-hand warning chips, which shifted it sideways whenever their
// text changed) -- the footer's own `justify-between` already does this once the two groups are
// separate flex children. The Approval mode switch this bar used to carry (T033) moved to the
// ApprovalModePill above the message box (MessageInput.tsx, T098, FR-056): Refract's Approval
// mode control lives there now, not here.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangleIcon, DownloadIcon, LoaderCircleIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { checkForUpdates, updateAnnouncementText, updateBadgeText, useUpdateInstallAction } from '@/lib/updateActions'
import { useHealthStore, useMemoryStore, useSessionsStore, useUpdateStore } from '@/state'
import { UpdateActionRow } from '../updates/UpdateActionRow'

function pluralAgents(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'} running`
}

// Quality-gate remediation (UI Medium "the same chip class string is copied 4 times"): one
// shared constant for the amber "needs you" warning chips (low memory, omp version, and a
// failed update) --
const WARNING_CHIP_CLASS = cn(
  badgeVariants({ variant: 'outline' }),
  'h-6 gap-1.5 border-state-needs-you/50 bg-state-needs-you/10 px-2.5 text-state-needs-you hover:bg-state-needs-you/20'
)

// Quality-gate remediation (UI Medium "the badge reuses state-working, which DESIGN.md reserves
// for session states"): a neutral outline chip for 'an update exists/is downloading/is ready'
// -- never the green session-state accent, and never the amber warning colour either (spec 006
// roadmap: "state-needs-you only for failed").
const NEUTRAL_CHIP_CLASS = cn(badgeVariants({ variant: 'outline' }), 'h-6 gap-1.5 px-2.5 text-foreground hover:bg-muted')

export function StatusBar() {
  const warning = useMemoryStore((state) => state.warning)
  const ompVersionWarning = useHealthStore((state) => state.ompVersionWarning)
  const sessions = useSessionsStore((state) => state.sessions)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const updateState = useUpdateStore((state) => state.state)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [ompOpen, setOmpOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const { busy: installBusy, error: installError, runInstall, runRetry } = useUpdateInstallAction()
  const [announcement, announce] = useClearedAnnouncement()
  const popoverTitleRef = useRef<HTMLParagraphElement>(null)
  const prevPhaseRef = useRef(updateState.phase)
  const prevHasActionRef = useRef(false)

  const liveSessions = sessions.filter((session) => session.status !== 'stopped')

  // Spec 006 contracts/ipc.md "Updates", research.md decision 11: shown once `phase` leaves
  // 'idle'/'checking' -- hidden entirely before that (FR-012, FR-013). Reachable at any other
  // time via the Settings screen's own Updates section (UpdatesSection.tsx) instead.
  const updateVisible = updateState.phase !== 'idle' && updateState.phase !== 'checking'
  // Quality-gate remediation (UI High "a downloaded, verified update is silently thrown away" /
  // "the FR-018 install-failure report is erased"): main's own updates.check() is already a
  // no-op in these three phases (contracts/ipc.md), but hiding the button too stops a user ever
  // clicking it expecting a fresh check mid-download or mid-install.
  const updateBusyPhase = updateState.phase === 'downloading' || updateState.phase === 'installing' || updateState.phase === 'downloaded'

  const handleCheckForUpdates = useCallback(async () => {
    setChecking(true)
    try {
      await checkForUpdates()
    } catch (error) {
      console.debug('[refract] updates.check: invoke failed', error)
    } finally {
      setChecking(false)
    }
  }, [])

  // A11y High "the badge/popover change ... none of this is inside a live region": announces
  // every phase change while the badge is actually showing something -- idle/checking stay
  // silent by design (same rule the badge's own visibility already follows).
  useEffect(() => {
    if (prevPhaseRef.current !== updateState.phase && updateVisible) {
      announce(updateAnnouncementText(updateState))
    }
    prevPhaseRef.current = updateState.phase
  }, [updateState, updateVisible, announce])

  // Quality-gate remediation (Medium "updateOpen is never reset when the badge hides"): the
  // Popover below unmounts the instant updateVisible flips false; without this, 'open' survives
  // and the NEXT time the badge appears it reopens by itself under the cursor.
  useEffect(() => {
    if (!updateVisible) setUpdateOpen(false)
  }, [updateVisible])

  // A11y High "focus is never restored ... when the Update button is replaced": the same "did
  // the control that just disappeared have focus" proxy Readiness.tsx's own install-focus effect
  // and AppearanceSection.tsx's Save/Cancel-disabled effect already rely on -- removing a
  // focused element always drops focus to <body> synchronously, so checking
  // document.activeElement === document.body here is the only reliable signal.
  useEffect(() => {
    const hasAction = updateState.phase === 'available' || updateState.phase === 'failed'
    if (prevHasActionRef.current && !hasAction && document.activeElement === document.body) {
      popoverTitleRef.current?.focus()
    }
    prevHasActionRef.current = hasAction
  }, [updateState.phase])

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        {warning && (
          <Popover open={memoryOpen} onOpenChange={setMemoryOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={WARNING_CHIP_CLASS}>
                <AlertTriangleIcon aria-hidden className="size-3" />
                Low memory: {pluralAgents(warning.liveAgents)}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start">
              <p className="font-medium text-foreground">Free up memory</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Refract never stops an agent on its own. Stop one below to free memory.
              </p>
              {liveSessions.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">No running agents.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-1">
                  {liveSessions.map((session) => (
                    <li key={session.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-foreground">{session.name}</span>
                      <Button size="xs" variant="outline" onClick={() => void stopAgent(session.id)}>
                        Stop agent
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
        )}
        {ompVersionWarning && (
          <Popover open={ompOpen} onOpenChange={setOmpOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={WARNING_CHIP_CLASS}>
                <AlertTriangleIcon aria-hidden className="size-3" />
                omp {ompVersionWarning.found}: unverified version
              </button>
            </PopoverTrigger>
            <PopoverContent align="start">
              <p className="font-medium text-foreground">Unverified omp version</p>
              <p className="mt-1 text-xs text-muted-foreground">{ompVersionWarning.hint}</p>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div className="flex items-center gap-2">
        {updateVisible && (
          <Popover open={updateOpen} onOpenChange={setUpdateOpen}>
            <PopoverTrigger asChild>
              <button type="button" className={updateState.phase === 'failed' ? WARNING_CHIP_CLASS : NEUTRAL_CHIP_CLASS}>
                {updateState.phase === 'failed' ? (
                  <AlertTriangleIcon aria-hidden className="size-3" />
                ) : updateState.phase === 'downloading' ? (
                  <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                ) : (
                  <DownloadIcon aria-hidden className="size-3" />
                )}
                {updateBadgeText(updateState)}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" aria-labelledby="update-popover-title">
              <p
                id="update-popover-title"
                ref={popoverTitleRef}
                tabIndex={-1}
                className="font-medium text-foreground outline-none"
              >
                {updateBadgeText(updateState)}
              </p>
              {updateState.notesUrl && (
                <a
                  href={updateState.notesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-foreground underline underline-offset-2"
                >
                  Release notes
                </a>
              )}
              <div className="mt-3 flex flex-col items-end gap-2">
                <UpdateActionRow
                  state={updateState}
                  busy={installBusy}
                  installError={installError}
                  onInstall={() => void runInstall()}
                  onRetry={() => void runRetry()}
                />
                {!updateBusyPhase && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-disabled={checking || undefined}
                    className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                    onClick={() => {
                      if (!checking) void handleCheckForUpdates()
                    }}
                  >
                    {checking && <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />}
                    Check for updates
                  </Button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </footer>
  )
}
