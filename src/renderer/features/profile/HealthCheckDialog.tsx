// Health check (spec 008 FR-022, T024): reachable from the profile menu, re-running the exact
// same `readiness.check()` the first-run Readiness screen uses, rendering each row through the
// shared CheckRow.tsx (extracted from Readiness.tsx) so the icon, colour, and found/hint text
// never drift from what that screen already shows -- this dialog's only addition is making the
// state word VISIBLE (`showStateWord`) instead of `sr-only`, since a deliberate "run a check"
// action reads better with it on screen. Never invents a hint string or a version number: every
// value rendered comes straight from the real `Check` the main process returned.
//
// Post-build review fixes: `healthCheckAnnouncement` counts failures and warnings separately so
// the announcement never conflates a real failure with a row that merely "needs attention" (a
// warning); `runCheck`'s own `catch` mirrors Readiness.tsx's -- a thrown `readiness.check` marks
// every row failed with a real hint rather than leaving "Checking…" as the last thing announced;
// and a re-run keeps the previous `checks` on screen (dimmed, `aria-busy`) instead of passing
// `undefined` for every row, so the dialog never shrinks and Check again never moves under the
// pointer mid re-run.
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
  /** Called on close (Esc, the X button, Done, or programmatically) -- each caller
   *  (ProfileItem.tsx's profile-menu item, ProfileAlertRows.tsx's "Check" action, issue #560)
   *  owns its own `open` state and its own instance of this dialog, and returns focus to
   *  whichever control it opened from, the same explicit close-auto-focus every dialog here
   *  needs since none is given a `Trigger`. */
  onCloseFocus?(): void
}

function checksFromError(error: IpcError): ReadinessChecks {
  const failed: Check = { ok: false, hint: error.message }
  return { git: failed, omp: failed, ompSignedIn: failed }
}

function warningPhrase(count: number): string {
  return count === 1 ? 'with a warning' : 'with warnings'
}

/** H1 (post-build review): counts failures and warnings separately, since a pass-with-a-warning
 *  row is never a failure (CheckRow.tsx's own "Passed with a warning" state) -- the old
 *  "{n} need attention" wording conflated the two and was also ungrammatical for n=1. */
function healthCheckAnnouncement(checks: ReadinessChecks): string {
  let failed = 0
  let warned = 0
  for (const key of CHECK_ORDER) {
    const check = checks[key]
    if (!check.ok) failed++
    else if (check.warning) warned++
  }
  if (failed > 0) {
    const warnSuffix = warned > 0 ? `, ${warned} passed ${warningPhrase(warned)}` : ''
    return `Health check complete. ${failed} ${failed === 1 ? 'check' : 'checks'} failed${warnSuffix}.`
  }
  if (warned > 0) {
    return `Health check complete. All checks passed, ${warned} ${warningPhrase(warned)}.`
  }
  return 'Health check complete. All checks passed.'
}

export function HealthCheckDialog({ open, onOpenChange, onCloseFocus }: HealthCheckDialogProps) {
  const [checks, setChecks] = useState<ReadinessChecks | null>(null)
  const [loading, setLoading] = useState(false)
  const [polite, announcePolite] = useClearedAnnouncement()
  const [assertive, announceAssertive] = useClearedAnnouncement()
  const doneRef = useRef<HTMLButtonElement>(null)
  const checkAgainRef = useRef<HTMLButtonElement>(null)
  // NEW-F (Phase 6 re-check): a run-id guard so closing and reopening the dialog mid-run (which
  // starts a second `runCheck`) can never have the first run's stale `finally` clear `loading`
  // or overwrite the second run's still-in-flight results.
  const runIdRef = useRef(0)

  async function runCheck(focusCheckAgain: boolean): Promise<void> {
    const id = ++runIdRef.current
    setLoading(true)
    // NEW-B (Phase 6 re-check): clear the OTHER live region too -- setting the same text twice in
    // the same region is a no-op React commit, so a second identical result within
    // useClearedAnnouncement's 6s window would otherwise announce nothing.
    announcePolite('Checking…')
    announceAssertive('')
    try {
      const result = await window.refract.readiness.check()
      if (id !== runIdRef.current) return
      const next = result.ok ? result.value : checksFromError(result.error)
      setChecks(next)
      useHealthStore.getState().setOmpCheck(next.omp)
      announcePolite(healthCheckAnnouncement(next))
    } catch (error) {
      if (id !== runIdRef.current) return
      console.debug('[refract] readiness.check: invoke failed', error)
      const failed: Check = { ok: false, hint: 'The check could not run. Try Check again.' }
      setChecks({ git: failed, omp: failed, ompSignedIn: failed })
      announcePolite('')
      announceAssertive('Health check couldn\'t run.')
    } finally {
      if (id === runIdRef.current) {
        setLoading(false)
        if (focusCheckAgain) checkAgainRef.current?.focus()
      }
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
        className="min-w-0 sm:max-w-lg"
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
        <ul
          role="list"
          aria-label="Health checks"
          aria-busy={loading || undefined}
          className={`flex flex-col gap-2${loading && checks !== null ? ' opacity-80' : ''}`}
        >
          {CHECK_ORDER.map((key) => (
            <CheckRow
              key={key}
              label={CHECK_LABELS[key]}
              check={checks?.[key]}
              checking={loading && checks === null}
              showStateWord
            />
          ))}
        </ul>
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {polite}
        </div>
        <div aria-live="assertive" aria-atomic="true" className="sr-only">
          {assertive}
        </div>
        <DialogFooter>
          <Button
            ref={checkAgainRef}
            variant="outline"
            aria-disabled={loading || undefined}
            className="min-w-28 aria-disabled:pointer-events-none aria-disabled:opacity-50"
            onClick={() => {
              if (!loading) void runCheck(true)
            }}
          >
            {loading ? 'Checking…' : 'Check again'}
          </Button>
          <Button ref={doneRef} onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
