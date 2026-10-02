import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AddRepositoryDialog } from '@/features/sessions/AddRepositoryDialog'
import type { Check, IpcError, Readiness as ReadinessChecks } from '../../../shared/ipc'

const CHECK_ORDER = ['git', 'omp', 'ompSignedIn'] as const

const CHECK_LABELS: Record<(typeof CHECK_ORDER)[number], string> = {
  git: 'Git found',
  omp: 'OMP found, on the supported version',
  ompSignedIn: 'OMP signed in'
}

const NOT_READY: Check = { ok: false }

function checksFromError(error: IpcError): ReadinessChecks {
  const failed: Check = { ok: false, hint: error.message }
  return { git: failed, omp: failed, ompSignedIn: failed }
}

export interface ReadinessProps {
  /** Seeds the checklist without calling the real API; only used to drive screenshot verification. */
  initialChecks?: ReadinessChecks
  /** Called whenever the all-checks-pass state changes, so the app shell can decide what to show. */
  onReadyChange?: (ready: boolean) => void
}

// The first-run checklist (docs/DESIGN.md "First run and empty states", FR-036): git found, OMP
// found on the supported version, OMP signed in. One primary Add repository action, disabled
// until every check passes.
export function Readiness({ initialChecks, onReadyChange }: ReadinessProps) {
  const [checks, setChecks] = useState<ReadinessChecks | null>(initialChecks ?? null)
  const [checking, setChecking] = useState(false)

  const runCheck = useCallback(async () => {
    setChecking(true)
    try {
      const result = await window.refract.readiness.check()
      setChecks(result.ok ? result.value : checksFromError(result.error))
    } catch (error) {
      console.debug('[refract] readiness.check: invoke failed (handler not registered yet)', error)
      setChecks({ git: NOT_READY, omp: NOT_READY, ompSignedIn: NOT_READY })
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    if (!initialChecks) void runCheck()
    // Runs once on mount; `initialChecks` and `runCheck` are stable for the lifetime of a screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const allPass = checks !== null && CHECK_ORDER.every((key) => checks[key].ok)

  useEffect(() => {
    onReadyChange?.(allPass)
  }, [allPass, onReadyChange])

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-card-foreground">
        <h1 className="text-base font-medium">Get Refract ready</h1>
        <p className="mt-0.5 text-sm italic text-muted-foreground">One Pi, every angle.</p>
        <p className="mt-2 text-sm text-muted-foreground">Refract checks these before a repository can be added.</p>
        <ul aria-label="Readiness checklist" aria-live="polite" className="mt-4 flex flex-col gap-3">
          {CHECK_ORDER.map((key) => {
            const check = checks?.[key]
            return (
              <li key={key} className="flex items-start gap-2.5">
                <CheckStatusIcon check={check} checking={checking && checks === null} />
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm">{CHECK_LABELS[key]}</span>
                  {check?.found && <span className="text-xs text-muted-foreground">{check.found}</span>}
                  {check && !check.ok && check.hint && <span className="text-xs text-destructive">{check.hint}</span>}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="mt-5 flex items-center gap-2">
          <AddRepositoryDialog trigger={<Button disabled={!allPass} className="flex-1" aria-disabled={!allPass}>Add repository</Button>} />
          <Button variant="outline" onClick={() => void runCheck()} disabled={checking}>
            {checking && <LoaderCircleIcon aria-hidden className="animate-spin" />}
            Re-check
          </Button>
        </div>
      </div>
    </div>
  )
}

function CheckStatusIcon({ check, checking }: { check?: Check; checking: boolean }): ReactNode {
  if (!check) {
    return checking ? (
      <>
        <LoaderCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
        <span className="sr-only">Checking</span>
      </>
    ) : (
      <>
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">Not checked yet</span>
      </>
    )
  }
  return check.ok ? (
    <>
      <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-500" />
      <span className="sr-only">Passed</span>
    </>
  ) : (
    <>
      <CircleXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span className="sr-only">Failed</span>
    </>
  )
}
