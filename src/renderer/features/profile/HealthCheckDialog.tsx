// Re-runs `readiness.check()` through the shared CheckRow with the state word visible. Never invents a
// hint or version: every value comes from the real `Check`. A thrown check marks every row failed, and a
// re-run keeps the previous `checks` on screen (dimmed, `aria-busy`) so the dialog does not shrink.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useAccountsStore, useHealthStore } from '@/state'
import type { Check, IpcError, Readiness as ReadinessChecks } from '../../../shared/ipc'
import { CHECK_LABELS, CHECK_ORDER, CheckRow } from '../readiness/CheckRow'

export interface HealthCheckDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Called on close; each caller owns its `open` state and returns focus to its opener (no `Trigger`). */
  onCloseFocus?(): void
}

function checksFromError(error: IpcError): ReadinessChecks {
  const failed: Check = { ok: false, hint: error.message }
  return { git: failed, omp: failed, ompSignedIn: failed }
}

function warningPhrase(count: number): string {
  return count === 1 ? 'with a warning' : 'with warnings'
}

/** Counts failures and warnings separately; a pass-with-a-warning row is never a failure. */
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
  const githubStatus = useAccountsStore((state) => state.githubStatus)
  const doneRef = useRef<HTMLButtonElement>(null)
  const checkAgainRef = useRef<HTMLButtonElement>(null)
  // Run-id guard: a stale first run's `finally` must not clear `loading` or overwrite a second run's results.
  const runIdRef = useRef(0)

  async function runCheck(focusCheckAgain: boolean): Promise<void> {
    const id = ++runIdRef.current
    setLoading(true)
    // Clear the other live region too: identical text twice in one region is a no-op commit and would announce nothing.
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
    // Re-checks on every open; `runCheck` closes over nothing that changes.
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
          <DialogDescription>Checks that Git and the agent are ready.</DialogDescription>
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
        {githubStatus !== 'ready' && githubStatus !== 'loading' && (
          <p className="text-xs text-muted-foreground">GitHub isn't ready. Open Manage accounts from the profile menu to sign in or fix it.</p>
        )}
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
            className="min-w-28 aria-disabled:opacity-50"
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
