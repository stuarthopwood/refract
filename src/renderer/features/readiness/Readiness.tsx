import { useCallback, useEffect, useState } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TitlebarBand } from '@/components/TitlebarBand'
import refractHero from '@/assets/brand/refract-hero.svg'
import { AddProjectMenu } from '@/features/sessions/AddProjectMenu'
import type { Check, IpcError, Readiness as ReadinessChecks } from '../../../shared/ipc'
import { useHealthStore } from '@/state'
import { Stepper } from '@/components/Stepper'
import { CHECK_LABELS, CHECK_ORDER, CheckRow } from './CheckRow'

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
// until every check passes. Per-row rendering lives in CheckRow.tsx (spec 008 T024), shared with
// the profile menu's Health check dialog.
export function Readiness({ initialChecks, onReadyChange }: ReadinessProps) {
  const [checks, setChecks] = useState<ReadinessChecks | null>(initialChecks ?? null)
  const [checking, setChecking] = useState(false)

  const runCheck = useCallback(async () => {
    setChecking(true)
    try {
      const result = await window.refract.readiness.check()
      const nextChecks = result.ok ? result.value : checksFromError(result.error)
      setChecks(nextChecks)
      useHealthStore.getState().setOmpCheck(nextChecks.omp)
    } catch (error) {
      console.debug('[refract] readiness.check: invoke failed', error)
      const failed: Check = { ok: false, hint: 'The check could not run. Try Re-check.' }
      setChecks({ git: failed, omp: failed, ompSignedIn: failed })
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

  const failedKey = checks ? CHECK_ORDER.find((key) => !checks[key].ok) : undefined
  const failedStep = failedKey ? CHECK_ORDER.indexOf(failedKey) + 1 : 0

  return (
    <div className="relative isolate h-full">
      <TitlebarBand reservesWindowControls />
      <div className="flex h-full flex-col items-center justify-center gap-8 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center justify-center gap-5">
          <img src={refractHero} alt="" aria-hidden className="h-16 w-16 shrink-0 sm:h-24 sm:w-24" />
          <div className="flex flex-col">
            <span className="font-brand text-5xl font-bold leading-none text-foreground sm:text-7xl">Refract</span>
            <span className="font-brand mt-2 text-lg font-medium leading-tight tracking-wide text-muted-foreground sm:text-xl">One Pi, every angle.</span>
          </div>
        </div>
        <div className="w-full max-w-sm p-6 text-foreground">
          <h1 tabIndex={-1} data-readiness-root className="text-base font-medium outline-none">
            {failedKey ? 'Refract can’t start yet' : allPass ? 'Add a project to begin' : 'Getting Refract ready'}
          </h1>
          {/* Polite live region, always mounted: the failure text is the one thing announced, not the whole list. */}
          <p aria-live="polite" className="mt-2 text-sm text-muted-foreground">
            {failedKey
              ? `Step ${failedStep} of ${CHECK_ORDER.length} failed: ${CHECK_LABELS[failedKey]}.`
              : allPass
                ? ''
                : 'Checking git and the agent…'}
          </p>
          {failedKey && checks && (
            <Stepper label="Readiness steps">
              {CHECK_ORDER.map((key, i) => (
                <CheckRow key={key} step={i + 1} label={CHECK_LABELS[key]} check={key === failedKey ? checks[key] : { ...checks[key], hint: undefined }} checking={false} />
              ))}
            </Stepper>
          )}
          <div className="mt-4 flex items-center gap-2">
            <AddProjectMenu variant="first-run" disabled={!allPass} />
            {(failedKey || checking) && (
              <Button variant="ghost" onClick={() => void runCheck()} disabled={checking}>
                {checking && <LoaderCircleIcon aria-hidden className="animate-spin" />}
                Re-check
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
