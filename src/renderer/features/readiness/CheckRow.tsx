import type { ReactNode } from 'react'
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { StepperItem } from '@/components/Stepper'
import type { Check } from '../../../shared/ipc'

export const CHECK_ORDER = ['git', 'omp', 'ompSignedIn'] as const

export const CHECK_LABELS: Record<(typeof CHECK_ORDER)[number], string> = {
  git: 'Git found',
  omp: 'Agent found, on the supported version',
  ompSignedIn: 'Agent signed in'
}

/** The word `CheckStatusIcon`'s `sr-only` text uses for each state, shared so a visible consumer cannot drift from what a screen reader hears. */
export function checkStateWord(check: Check | undefined, checking: boolean): string {
  if (!check) return checking ? 'Checking' : 'Not checked yet'
  if (check.ok && check.warning) return 'Passed with a warning'
  return check.ok ? 'Passed' : 'Failed'
}

export function CheckStatusIcon({
  check,
  checking,
  srWord = true
}: {
  check?: Check
  checking: boolean
  srWord?: boolean
}): ReactNode {
  const word = checkStateWord(check, checking)
  if (!check) {
    return checking ? (
      <>
        <LoaderCircleIcon aria-hidden className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground" />
        {srWord && <span className="sr-only">{word}</span>}
      </>
    ) : (
      <>
        <CircleAlertIcon aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
        {srWord && <span className="sr-only">{word}</span>}
      </>
    )
  }
  if (check.ok && check.warning) {
    return (
      <>
        <TriangleAlertIcon aria-hidden className="mt-1 size-4 shrink-0 text-state-needs-you" />
        {srWord && <span className="sr-only">{word}</span>}
      </>
    )
  }
  return check.ok ? (
    <>
      <CircleCheckIcon aria-hidden className="mt-1 size-4 shrink-0 text-state-working" />
      {srWord && <span className="sr-only">{word}</span>}
    </>
  ) : (
    <>
      <CircleXIcon aria-hidden className="mt-1 size-4 shrink-0 text-destructive" />
      {srWord && <span className="sr-only">{word}</span>}
    </>
  )
}

export interface CheckRowProps {
  label: string
  check?: Check
  checking: boolean
  showStateWord?: boolean
  /** 1-based position; when set the row renders as a shared stepper step (launch-failure view) instead of a checklist row. */
  step?: number
}

export function CheckRow({ label, check, checking, showStateWord = false, step }: CheckRowProps) {
  if (step !== undefined) {
    const status = !check ? 'pending' : check.ok ? 'done' : 'failed'
    return (
      <StepperItem index={step} status={status} title={label}>
        {check?.found && <span className="text-xs text-muted-foreground">{check.found}</span>}
        {check && !check.ok && check.hint && <span className="text-sm text-destructive">{check.hint}</span>}
        {check?.ok && check.warning && check.hint && <span className="text-xs text-state-needs-you">{check.hint}</span>}
        <span className="sr-only">{checkStateWord(check, checking)}</span>
      </StepperItem>
    )
  }
  return (
    <li className="flex items-start gap-2">
      <CheckStatusIcon check={check} checking={checking} srWord={!showStateWord} />
      <div className="flex min-w-0 flex-col">
        <span className="text-sm">
          {label}
          {showStateWord && (
            <span className="whitespace-nowrap text-muted-foreground"> — {checkStateWord(check, checking)}</span>
          )}
        </span>
        {check?.found && <span className="text-xs text-muted-foreground">{check.found}</span>}
        {check && !check.ok && check.hint && <span className="text-xs text-destructive">{check.hint}</span>}
        {check && check.ok && check.warning && check.hint && <span className="text-xs text-state-needs-you">{check.hint}</span>}
      </div>
    </li>
  )
}
