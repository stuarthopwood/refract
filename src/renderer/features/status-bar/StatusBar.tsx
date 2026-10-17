// Status bar (docs/DESIGN.md "Layout"): the update-availability badge is the one always-visible
// control left here. The Approval mode switch this bar used to carry (T033) moved to the
// ApprovalModePill above the message box (MessageInput.tsx, T098, FR-056); the low-memory and
// unverified-omp-version notices (issue #560, spec 001 FR-037/FR-072) moved to the quiet alert
// rows directly under the profile item (ProfileAlertRows.tsx), replacing this footer's own
// Popovers for both.
import { useState } from 'react'
import { AlertTriangleIcon, DownloadIcon } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { updateUnavailableReasonText } from '@/lib/updateStatus'
import { notify, useUpdateStore } from '@/state'
import type { UpdateState } from '../../../shared/updates'

/** Gate finding (round 2, Medium): the footer's own badge TEXT must stay short -- `lastError`
 * can be an arbitrary, sometimes-long capped string (a process failure detail); the full text
 * belongs in the popover row below, not inlined into the always-visible footer. */
function updateBadgeShortLabel(state: UpdateState, unavailable: boolean): string {
  if (state.phase === 'failed') return 'Update failed'
  if (unavailable) return 'Update check unavailable'
  if (state.phase === 'downloading') return 'Downloading update'
  if (state.phase === 'downloaded') return 'Update ready: installs on quit'
  return `Update available: v${state.availableVersion}`
}

export function StatusBar() {
  const updateState = useUpdateStore((state) => state.state)
  const [updateOpen, setUpdateOpen] = useState(false)
  // Shared by the Download button (available phase) and the Retry button (failed phase) --
  // mutually exclusive phases, so one busy flag never collides between the two actions.
  const [actionBusy, setActionBusy] = useState(false)
  // FR-017: the one other reachable "something's off" update state besides `'failed'` --
  // see `updateUnavailableReasonText`'s own doc comment for why this is `'idle'`, not `'failed'`.
  const updateUnavailable = updateState?.phase === 'idle' && updateState.unavailableReason !== undefined
  const updateTroubled = updateState?.phase === 'failed' || updateUnavailable

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-divider bg-card px-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        {updateState &&
          (updateState.phase === 'available' ||
            updateState.phase === 'downloading' ||
            updateState.phase === 'downloaded' ||
            updateState.phase === 'failed' ||
            updateUnavailable) && (
            <Popover open={updateOpen} onOpenChange={setUpdateOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    badgeVariants({ variant: 'outline' }),
                    updateTroubled
                      ? 'h-6 gap-1.5 border-state-needs-you/50 bg-state-needs-you/10 px-2.5 text-state-needs-you hover:bg-state-needs-you/20'
                      : 'h-6 gap-1.5 px-2.5 hover:bg-accent'
                  )}
                >
                  {updateTroubled ? (
                    <AlertTriangleIcon aria-hidden className="size-3" />
                  ) : (
                    <DownloadIcon aria-hidden className="size-3" />
                  )}
                  {updateBadgeShortLabel(updateState, updateUnavailable)}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end">
                <p className="font-medium text-foreground">
                  {updateState.phase === 'failed'
                    ? 'Update failed'
                    : updateUnavailable
                      ? 'Update check unavailable'
                      : updateState.phase === 'downloaded'
                        ? 'Update downloaded'
                        : updateState.phase === 'downloading'
                          ? 'Downloading update'
                          : `Refract v${updateState.availableVersion} is available`}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {updateState.phase === 'failed'
                    ? (updateState.lastError ?? 'Update failed for an unknown reason.')
                    : updateUnavailable
                      ? updateUnavailableReasonText(updateState.unavailableReason!)
                      : updateState.phase === 'downloaded'
                        ? 'Installs automatically the next time you quit Refract; a running agent is never interrupted.'
                        : updateState.phase === 'downloading'
                          ? 'Downloading the update now; it installs the next time you quit, never interrupting a running agent.'
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
                  {(updateState.phase === 'failed' || updateUnavailable) && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={actionBusy}
                      onClick={() => {
                        setActionBusy(true)
                        void window.refract.updates.check().finally(() => setActionBusy(false))
                      }}
                    >
                      {actionBusy ? 'Checking…' : 'Check again'}
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
