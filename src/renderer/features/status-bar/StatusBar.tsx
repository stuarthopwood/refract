// Status bar (docs/DESIGN.md "Layout"): the T039 low-memory notice (contracts/ipc.md
// `memory:warning`, FR-037) and the omp-version notice (readiness.ts, health-store.ts) are the
// two always-visible controls here. The Approval mode switch this bar used to carry (T033)
// moved to the ApprovalModePill above the message box (MessageInput.tsx, T098, FR-056):
// Refract's Approval mode control lives there now, not here.
import { useState } from 'react'
import { AlertTriangleIcon, DownloadIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { notify, useHealthStore, useMemoryStore, useSessionsStore, useUpdateStore } from '@/state'
import type { UpdateState } from '../../../shared/ipc'

function pluralAgents(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'} running`
}

/** FR-017/data-model.md "unavailableReason": the one case `checker.rs` can leave on a `'failed'`
 * badge alongside (or instead of) `lastError` -- a plain-words explanation, never the raw enum
 * value, matching the Electron reference's `updateStatusText` (src/renderer/lib/updateActions.ts
 * on `origin/spec-006-impl`, mined/unfinished). */
function updateUnavailableReasonText(reason: NonNullable<UpdateState['unavailableReason']>): string {
  switch (reason) {
    case 'not-installed':
      return 'GitHub CLI is not installed.'
    case 'not-signed-in':
      return 'GitHub CLI is not signed in. Run gh auth login.'
    case 'offline':
      return 'Could not reach GitHub.'
  }
}

/** Gate finding (PR #829 round 1, HIGH): the status bar's own `'failed'` badge/popover text --
 * `lastError` first (set by every download/checksum/install-on-quit failure, checker.rs), else
 * `unavailableReason`'s own explanation, else a generic fallback. */
function updateFailureMessage(state: UpdateState): string {
  if (state.lastError) return state.lastError
  if (state.unavailableReason) return updateUnavailableReasonText(state.unavailableReason)
  return 'Update failed for an unknown reason.'
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
  // Shared by the Download button (available phase) and the Retry button (failed phase) --
  // mutually exclusive phases, so one busy flag never collides between the two actions.
  const [actionBusy, setActionBusy] = useState(false)
  const liveSessions = sessions.filter((session) => session.status !== 'stopped')

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-divider bg-card px-3 text-xs text-muted-foreground">
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
        {updateState &&
          (updateState.phase === 'available' ||
            updateState.phase === 'downloading' ||
            updateState.phase === 'downloaded' ||
            updateState.phase === 'failed') && (
            <Popover open={updateOpen} onOpenChange={setUpdateOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    badgeVariants({ variant: 'outline' }),
                    updateState.phase === 'failed'
                      ? 'h-6 gap-1.5 border-state-needs-you/50 bg-state-needs-you/10 px-2.5 text-state-needs-you hover:bg-state-needs-you/20'
                      : 'h-6 gap-1.5 px-2.5 hover:bg-accent'
                  )}
                >
                  {updateState.phase === 'failed' ? (
                    <AlertTriangleIcon aria-hidden className="size-3" />
                  ) : (
                    <DownloadIcon aria-hidden className="size-3" />
                  )}
                  {updateState.phase === 'failed'
                    ? `Update failed: ${updateFailureMessage(updateState)}`
                    : updateState.phase === 'downloaded'
                      ? 'Update ready: installs on quit'
                      : `Update available: v${updateState.availableVersion}`}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end">
                <p className="font-medium text-foreground">
                  {updateState.phase === 'failed'
                    ? 'Update failed'
                    : updateState.phase === 'downloaded'
                      ? 'Update downloaded'
                      : `Refract v${updateState.availableVersion} is available`}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {updateState.phase === 'failed'
                    ? updateFailureMessage(updateState)
                    : updateState.phase === 'downloaded'
                      ? 'Installs automatically the next time you quit Refract; a running agent is never interrupted.'
                      : 'Downloads and verifies the installer now; it installs the next time you quit, never interrupting a running agent.'}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  {updateState.phase === 'available' && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={actionBusy}
                      onClick={() => {
                        setActionBusy(true)
                        void window.refract.updates
                          .install()
                          .then((result) => {
                            if (!result.ok) notify(result.error)
                          })
                          .finally(() => setActionBusy(false))
                      }}
                    >
                      {actionBusy ? 'Downloading…' : 'Download update'}
                    </Button>
                  )}
                  {updateState.phase === 'failed' && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={actionBusy}
                      onClick={() => {
                        setActionBusy(true)
                        void window.refract.updates.check().finally(() => setActionBusy(false))
                      }}
                    >
                      {actionBusy ? 'Checking…' : 'Try again'}
                    </Button>
                  )}
                  {updateState.notesUrl && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        void window.refract.app.openReleaseNotes()
                      }}
                    >
                      Release notes
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
      </div>
    </footer>
  )
}