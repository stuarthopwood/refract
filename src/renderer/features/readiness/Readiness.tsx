import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { TitlebarBand } from '@/components/TitlebarBand'
import refractHero from '@/assets/brand/refract-hero.svg'
import { AddProjectMenu } from '@/features/sessions/AddProjectMenu'
import type { Check } from '../../../shared/ipc'
import type { ReadinessStepKey } from '../../../shared/updates'
import { useHealthStore, useRepositoriesStore } from '@/state'
import { Stepper, STEP_STATUS_WORD, type StepStatus } from '@/components/Stepper'
import { CHECK_ORDER } from './CheckRow'

export const STEP_TITLES: Record<ReadinessStepKey, string> = {
  git: 'Git Installation',
  omp: 'OMP Installation & Version',
  ompSignedIn: 'OMP Active Session'
}

/** How long the all-passed state stays on screen before the app takes over, so it is actually seen. */
const PASS_HOLD_MS = 700

type Results = Partial<Record<ReadinessStepKey, Check>>

async function runStep(key: ReadinessStepKey): Promise<Check> {
  try {
    const result = await window.refract.readiness.checkStep(key)
    return result.ok ? result.value : { ok: false, hint: result.error.message }
  } catch (error) {
    console.debug('[refract] readiness.checkStep: invoke failed', error)
    return { ok: false, hint: 'The check could not run. Try Re-check.' }
  }
}

export interface ReadinessProps {
  /** Called whenever the all-checks-pass state changes, so the app shell can decide what to show. */
  onReadyChange?: (ready: boolean) => void
}

// The launch screen (docs/DESIGN.md "First run and empty states", FR-036): git, OMP on the supported
// version, OMP signed in, run one after another on every launch and stopped at the first failure.
// Shown as a horizontal stepper; the selected step's detail sits below it.
export function Readiness({ onReadyChange }: ReadinessProps) {
  const [results, setResults] = useState<Results>({})
  const [runningKey, setRunningKey] = useState<ReadinessStepKey | null>(CHECK_ORDER[0])
  const [picked, setPicked] = useState<ReadinessStepKey | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const runId = useRef(0)
  const detailId = useId()
  const hasRepositories = useRepositoriesStore((state) => state.repositories.length > 0)

  const runChecks = useCallback(async () => {
    const id = ++runId.current
    setResults({})
    setPicked(null)
    for (const key of CHECK_ORDER) {
      setRunningKey(key)
      const check = await runStep(key)
      if (id !== runId.current) return
      setResults((previous) => ({ ...previous, [key]: check }))
      if (key === 'omp') useHealthStore.getState().setOmpCheck(check)
      if (!check.ok) break
    }
    setRunningKey(null)
    setRechecking(false)
  }, [])

  useEffect(() => {
    void runChecks()
    const current = runId
    // A superseded or unmounted run must not write state once its await returns.
    return () => {
      current.current++
    }
  }, [runChecks])

  const allPass = CHECK_ORDER.every((key) => results[key]?.ok)
  const failedKey = CHECK_ORDER.find((key) => results[key] && !results[key].ok)

  useEffect(() => {
    if (!allPass) {
      onReadyChange?.(false)
      return
    }
    const timer = setTimeout(() => onReadyChange?.(true), PASS_HOLD_MS)
    return () => clearTimeout(timer)
  }, [allPass, onReadyChange])

  const statusOf = (key: ReadinessStepKey): StepStatus => {
    const check = results[key]
    if (check) return check.ok ? 'passed' : 'failed'
    return runningKey === key ? 'running' : 'waiting'
  }

  const selectedKey = picked ?? failedKey ?? runningKey ?? (allPass ? CHECK_ORDER[CHECK_ORDER.length - 1] : null)
  const selected = selectedKey ? results[selectedKey] : undefined
  const selectedStatus = selectedKey ? statusOf(selectedKey) : null
  const failedStep = failedKey ? CHECK_ORDER.indexOf(failedKey) + 1 : 0
  const showRecheck = failedKey !== undefined || rechecking

  const recheck = () => {
    setRechecking(true)
    void runChecks()
  }

  return (
    <div className="relative isolate h-full">
      <TitlebarBand reservesWindowControls />
      <div className="flex h-full flex-col items-center justify-center gap-8 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center justify-center gap-4">
          <img src={refractHero} alt="" aria-hidden className="h-16 w-16 shrink-0 sm:h-24 sm:w-24" />
          <div className="flex flex-col">
            <span className="font-brand text-5xl font-bold leading-none text-foreground sm:text-7xl">Refract</span>
            <span className="font-brand mt-2 text-lg font-medium leading-tight tracking-wide text-muted-foreground sm:text-xl">One Pi, every angle.</span>
          </div>
        </div>
        <div className="w-full max-w-xl text-foreground">
          <h1 tabIndex={-1} data-readiness-root className="mb-4 text-center text-base font-medium outline-none">
            {failedKey ? 'Refract can’t start yet' : allPass ? (hasRepositories ? 'Refract is ready' : 'Add a project to begin') : 'Getting Refract ready'}
          </h1>
          {/* Polite live region, always mounted: only the failure or the all-passed result is announced, once. */}
          <p aria-live="polite" className="sr-only">
            {failedKey ? `Step ${failedStep} of ${CHECK_ORDER.length} failed: ${STEP_TITLES[failedKey]}.` : allPass ? 'All checks passed' : ''}
          </p>
          <Stepper
            label="Readiness steps"
            steps={CHECK_ORDER.map((key) => ({ key, title: STEP_TITLES[key], status: statusOf(key) }))}
            selectedKey={selectedKey ?? null}
            onSelect={(key) => setPicked(key as ReadinessStepKey)}
            detailId={detailId}
          />
          <div id={detailId} className="mt-6 flex min-h-12 flex-wrap items-start justify-between gap-2 text-sm">
            {selectedKey && selectedStatus && (
              <div className="flex min-w-0 flex-1 flex-col gap-1 break-words">
                <span className="font-medium">
                  {STEP_TITLES[selectedKey]} <span className="text-muted-foreground">({STEP_STATUS_WORD[selectedStatus]})</span>
                </span>
                {selectedStatus === 'waiting' && <span className="text-muted-foreground">Waiting for the earlier steps to pass.</span>}
                {selectedStatus === 'running' && <span className="text-muted-foreground">Checking…</span>}
                {selectedStatus === 'passed' && selected?.found && <span className="text-muted-foreground">{selected.found}</span>}
                {selectedStatus === 'passed' && selected?.warning && selected.hint && <span className="text-state-needs-you">{selected.hint}</span>}
                {selectedStatus === 'failed' && selected?.hint && <span className="text-destructive">{selected.hint}</span>}
              </div>
            )}
            {showRecheck && (
              <Button variant="ghost" onClick={recheck} loading={runningKey !== null}>
                Re-check
              </Button>
            )}
          </div>
          {allPass && !hasRepositories && (
            <div className="mt-4 flex justify-center">
              <AddProjectMenu variant="first-run" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
