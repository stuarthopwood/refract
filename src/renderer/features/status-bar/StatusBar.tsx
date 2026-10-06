// Status bar (docs/DESIGN.md "Layout"): the T039 low-memory notice (contracts/ipc.md
// `memory:warning`, FR-037), the omp-version notice (readiness.ts, health-store.ts), and (spec
// 006, research.md decision 11) the update badge are the always-visible controls here. The
// Approval mode switch this bar used to carry (T033) moved to the ApprovalModePill above the
// message box (MessageInput.tsx, T098, FR-056): Refract's Approval mode control lives there now,
// not here.
import { useCallback, useState } from 'react'
import { AlertTriangleIcon, DownloadIcon, LoaderCircleIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useHealthStore, useMemoryStore, useSessionsStore, useUpdateStore } from '@/state'
import type { UpdateState } from '../../../shared/ipc'

function pluralAgents(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'} running`
}

// Spec 006 contracts/ipc.md "Updates", research.md decision 11: one line of badge text per
// phase, shown once `phase` leaves 'idle'/'checking' -- hidden entirely before that (FR-012,
// FR-013).
function updateBadgeText(state: UpdateState): string {
  switch (state.phase) {
    case 'available':
      return `Refract ${state.availableVersion} available`
    case 'downloading':
      return `Downloading ${state.availableVersion}…`
    case 'downloaded':
      return `${state.availableVersion} ready to install`
    case 'installing':
      return 'Installing the update…'
    case 'failed':
      return 'Update check failed'
    default:
      return ''
  }
}

export function StatusBar() {
  const warning = useMemoryStore((state) => state.warning)
  const ompVersionWarning = useHealthStore((state) => state.ompVersionWarning)
  const sessions = useSessionsStore((state) => state.sessions)
  const stopAgent = useSessionsStore((state) => state.stopAgent)
  const updateState = useUpdateStore((state) => state.state)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [ompOpen, setOmpOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)

  const liveSessions = sessions.filter((session) => session.status !== 'stopped')

  const handleCheckForUpdates = useCallback(async () => {
    setUpdateBusy(true)
    try {
      const result = await window.refract.updates.check()
      if (result.ok) useUpdateStore.getState().setState(result.value)
    } catch (error) {
      console.debug('[refract] updates.check: invoke failed', error)
    } finally {
      setUpdateBusy(false)
    }
  }, [])

  const handleInstallUpdate = useCallback(async () => {
    setUpdateBusy(true)
    try {
      await window.refract.updates.install()
    } catch (error) {
      console.debug('[refract] updates.install: invoke failed', error)
    } finally {
      setUpdateBusy(false)
    }
  }, [])

  const updateVisible = updateState.phase !== 'idle' && updateState.phase !== 'checking'

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        {warning && (
          <Popover open={memoryOpen} onOpenChange={setMemoryOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  badgeVariants({ variant: 'outline' }),
                  'h-6 gap-1.5 border-state-needs-you/50 bg-state-needs-you/10 px-2.5 text-state-needs-you hover:bg-state-needs-you/20'
                )}
              >
                <AlertTriangleIcon aria-hidden className="size-3" />
                Low memory: {pluralAgents(warning.liveAgents)}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end">
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
              <button
                type="button"
                className={cn(
                  badgeVariants({ variant: 'outline' }),
                  'h-6 gap-1.5 border-state-needs-you/50 bg-state-needs-you/10 px-2.5 text-state-needs-you hover:bg-state-needs-you/20'
                )}
              >
                <AlertTriangleIcon aria-hidden className="size-3" />
                omp {ompVersionWarning.found}: unverified version
              </button>
            </PopoverTrigger>
            <PopoverContent align="end">
              <p className="font-medium text-foreground">Unverified omp version</p>
              <p className="mt-1 text-xs text-muted-foreground">{ompVersionWarning.hint}</p>
            </PopoverContent>
          </Popover>
        )}
        {updateVisible && (
          <Popover open={updateOpen} onOpenChange={setUpdateOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  badgeVariants({ variant: 'outline' }),
                  updateState.phase === 'failed'
                    ? 'h-6 gap-1.5 border-state-needs-you/50 bg-state-needs-you/10 px-2.5 text-state-needs-you hover:bg-state-needs-you/20'
                    // state-working's contrast against --background is already confirmed at the
                    // WCAG AA text minimum (check:theme-contrast); reused here for "an update is
                    // available/downloading" rather than introducing an unverified text colour.
                    : 'h-6 gap-1.5 border-state-working/50 bg-state-working/10 px-2.5 text-state-working hover:bg-state-working/20'
                )}
              >
                {updateState.phase === 'failed' ? (
                  <AlertTriangleIcon aria-hidden className="size-3" />
                ) : (
                  <DownloadIcon aria-hidden className="size-3" />
                )}
                {updateBadgeText(updateState)}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end">
              <p className="font-medium text-foreground">{updateBadgeText(updateState)}</p>
              {updateState.phase === 'failed' && updateState.lastError && (
                <p className="mt-1 text-xs text-muted-foreground">{updateState.lastError}</p>
              )}
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
              <div className="mt-3 flex items-center gap-2">
                {updateState.phase === 'downloaded' ? (
                  <p className="text-xs text-muted-foreground">Quit Refract to finish installing.</p>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={updateBusy || updateState.phase === 'downloading' || updateState.phase === 'installing'}
                    onClick={() => void handleInstallUpdate()}
                  >
                    {updateState.phase === 'downloading' && <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />}
                    Update
                  </Button>
                )}
                <Button size="xs" variant="outline" disabled={updateBusy} onClick={() => void handleCheckForUpdates()}>
                  Check for updates
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </footer>
  )
}
