// One readiness check's row (extracted from Readiness.tsx, spec 008 T024): icon, label, and any
// found/hint text, shared so the profile menu's Health check dialog (HealthCheckDialog.tsx)
// renders the exact same row the first-run Readiness screen does, instead of a second
// hand-rolled copy that could drift from it. `showStateWord` defaults false so Readiness.tsx's
// own rendering is pixel-identical to before this extraction; only HealthCheckDialog.tsx sets it,
// since that dialog shows the state word visibly (Readiness.tsx leaves it `sr-only`, matching
// its own quieter first-run tone). `CheckStatusIcon`'s own `srWord` defaults true (Readiness's
// quieter, icon-plus-sr-only-word tone); `CheckRow` itself passes `srWord={!showStateWord}` below
// so a screen reader hears the state word exactly once whichever caller renders it, instead of
// once from the icon's own sr-only span and again from the row's visible one.
import type { ReactNode } from 'react'
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import type { Check } from '../../../shared/ipc'

export const CHECK_ORDER = ['git', 'omp', 'ompSignedIn'] as const

export const CHECK_LABELS: Record<(typeof CHECK_ORDER)[number], string> = {
  git: 'Git found',
  omp: 'OMP found, on the supported version',
  ompSignedIn: 'OMP signed in'
}

/** The exact word `CheckStatusIcon`'s own `sr-only` text already uses for each state -- kept as
 *  one function so a second consumer that needs it VISIBLE (HealthCheckDialog.tsx) can never
 *  drift from what a screen reader hears here. */
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
  /** Set false by a caller that already renders the state word itself (HealthCheckDialog.tsx's
   *  `showStateWord`), so a screen reader hears it exactly once instead of twice. */
  srWord?: boolean
}): ReactNode {
  const word = checkStateWord(check, checking)
  if (!check) {
    return checking ? (
      <>
        <LoaderCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
        {srWord && <span className="sr-only">{word}</span>}
      </>
    ) : (
      <>
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        {srWord && <span className="sr-only">{word}</span>}
      </>
    )
  }
  if (check.ok && check.warning) {
    return (
      <>
        <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-state-needs-you" />
        {srWord && <span className="sr-only">{word}</span>}
      </>
    )
  }
  return check.ok ? (
    <>
      <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-state-working" />
      {srWord && <span className="sr-only">{word}</span>}
    </>
  ) : (
    <>
      <CircleXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      {srWord && <span className="sr-only">{word}</span>}
    </>
  )
}

export interface CheckRowProps {
  label: ReactNode
  check?: Check
  checking: boolean
  /** HealthCheckDialog.tsx only: also shows the state word visibly next to the label. */
  showStateWord?: boolean
  /** Spec 006: an optional trailing action (Readiness.tsx's own Install button) rendered next
   *  to the label. Undefined for HealthCheckDialog.tsx's rows, which never install anything. */
  action?: ReactNode
  /** Spec 006: optional progress text under the row's found/hint text (Readiness.tsx's own
   *  Install action progress). Undefined for HealthCheckDialog.tsx's rows. */
  progress?: ReactNode
}

export function CheckRow({ label, check, checking, showStateWord = false, action, progress }: CheckRowProps) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckStatusIcon check={check} checking={checking} srWord={!showStateWord} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">
            {label}
            {showStateWord && (
              <span className="whitespace-nowrap text-muted-foreground"> — {checkStateWord(check, checking)}</span>
            )}
          </span>
          {action}
        </div>
        {check?.found && <span className="text-xs text-muted-foreground">{check.found}</span>}
        {check && !check.ok && check.hint && <span className="text-xs text-destructive">{check.hint}</span>}
        {check && check.ok && check.warning && check.hint && <span className="text-xs text-state-needs-you">{check.hint}</span>}
        {progress}
      </div>
    </li>
  )
}
