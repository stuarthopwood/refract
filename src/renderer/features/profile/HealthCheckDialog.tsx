// Health check (spec 008 FR-022, T024): reachable from the profile menu, re-running the exact
// same `readiness.check()` the first-run Readiness screen uses, rendering each row through the
// shared CheckRow.tsx (extracted from Readiness.tsx) so the icon, colour, and found/hint text
// never drift from what that screen already shows -- this dialog's only addition is making the
// state word VISIBLE (`showStateWord`) instead of `sr-only`, since a deliberate "run a check"
// action reads better with it on screen. Never invents a hint string or a version number: every
// value rendered comes straight from the real `Check` the main process returned.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useHealthStore } from '@/state'
import type { Check, IpcError, Readiness as ReadinessChecks } from '../../../shared/ipc'
import { CHECK_LABELS, CHECK_ORDER, CheckRow } from '../readiness/CheckRow'

export interface HealthCheckDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Called on close (Esc, the X button, Done, or programmatically) -- the caller
   *  (ProfileItem.tsx) returns focus to the profile item's name button, the same explicit
   *  close-auto-focus every dialog here needs since none is given a `Trigger`. */
  onCloseFocus?(): void
}

function checksFromError(error: IpcError): ReadinessChecks {
  const failed: Check = { ok: false, hint: error.message }
  return { git: failed, omp: failed, ompSignedIn: failed }
}

export function HealthCheckDialog({ open, onOpenChange, onCloseFocus }: HealthCheckDialogProps) {
  const [checks, setChecks] = useState<ReadinessChecks | null>(null)
  const [loading, setLoading] = useState(false)
  const [announcement, announce] = useClearedAnnouncement()
  const doneRef = useRef<HTMLButtonElement>(null)
  const checkAgainRef = useRef<HTMLButtonElement>(null)

  async function runCheck(focusCheckAgain: boolean): Promise<void> {
    setLoading(true)
    announce('Checking…')
    try {
      const result = await window.refract.readiness.check()
      const next = result.ok ? result.value : checksFromError(result.error)
      setChecks(next)
      useHealthStore.getState().setOmpCheck(next.omp)
      const needAttention = CHECK_ORDER.filter((key) => !next[key].ok || next[key].warning).length
      announce(needAttention === 0 ? 'Health check complete. All checks passed.' : `Health check complete. ${needAttention} need attention.`)
    } finally {
      setLoading(false)
      if (focusCheckAgain) checkAgainRef.current?.focus()
    }
  }

  useEffect(() => {
    if (!open) return
    void runCheck(false)
    // Re-checks fresh every time the dialog opens; `runCheck` closes over nothing that changes
    // across opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="min-w-0 sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          doneRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseFocus?.()
        }}
      >
        <DialogHeader>
          <DialogTitle>Health check</DialogTitle>
          <DialogDescription>Checks that Git and OMP are ready.</DialogDescription>
        </DialogHeader>
        <ul role="list" aria-label="Health checks" aria-busy={loading || undefined} className="flex flex-col gap-3">
          {CHECK_ORDER.map((key) => (
            <CheckRow
              key={key}
              label={CHECK_LABELS[key]}
              check={loading ? undefined : (checks?.[key] ?? undefined)}
              checking={loading}
              showStateWord
            />
          ))}
        </ul>
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
        <DialogFooter>
          <Button
            ref={checkAgainRef}
            variant="outline"
            aria-disabled={loading || undefined}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => {
              if (!loading) void runCheck(true)
            }}
          >
            Check again
          </Button>
          <Button ref={doneRef} onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
