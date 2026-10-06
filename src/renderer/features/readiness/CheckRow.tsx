// One readiness check's row (extracted from Readiness.tsx, spec 008 T024): icon, label, and any
// found/hint text, shared so the profile menu's Health check dialog (HealthCheckDialog.tsx)
// renders the exact same row the first-run Readiness screen does, instead of a second
// hand-rolled copy that could drift from it. 'showStateWord' defaults false so Readiness.tsx's
// own rendering is pixel-identical to before this extraction; only HealthCheckDialog.tsx sets it,
// since that dialog shows the state word visibly (Readiness.tsx leaves it sr-only, matching
// its own quieter first-run tone). CheckStatusIcon's own 'srWord' defaults true (Readiness's
// quieter, icon-plus-sr-only-word tone); CheckRow itself passes srWord={!showStateWord} below
// so a screen reader hears the state word exactly once whichever caller renders it, instead of
// once from the icon's own sr-only span and again from the row's visible one.
//
// Spec 006 quality-gate remediation: 'iconOverride'/'wordOverride' let a caller replace the
// pass/fail icon and its (visible or sr-only) word with a neutral one -- Readiness.tsx uses this
// for the optional GitHub CLI row (a neutral icon instead of the alarming red X for
// 'not set up'/'signed out', never a hard failure) and for the checkRunFailed state (the
// whole readiness check itself could not run, so every row shows 'Could not check' instead of a
// per-row failure). 'hideHint' lets a caller suppress the ordinary check.hint line once its own
// progress slot already carries the row's one outcome line, so the two never stack (gate
// finding: 'the old relaunch hint and the failure detail show as two stacked red lines'). Both
// default to their old behaviour (undefined/false) so HealthCheckDialog.tsx's own call site, which
// passes neither, renders exactly as before. 'contentRef' is a plain pass-through onto the row's
// label/hint container, always given tabIndex={-1} (harmless for HealthCheckDialog, which never
// reads it) so Readiness.tsx can restore focus to a row's own content when that row's Install
// button unmounts out from under a focused user (WCAG 2.4.3).
import type { ReactNode, Ref } from 'react'
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import type { Check } from '../../../shared/ipc'

export const CHECK_ORDER = ['git', 'omp', 'ompSignedIn'] as const

export const CHECK_LABELS: Record<(typeof CHECK_ORDER)[number], string> = {
  git: 'Git found',
  omp: 'OMP found, on the supported version',
  ompSignedIn: 'OMP signed in'
}

/** The exact word checkStateWord computes for each state -- kept as one function so a second
 *  consumer that needs it VISIBLE (HealthCheckDialog.tsx) can never drift from what a screen
 *  reader hears here. */
export function checkStateWord(check: Check | undefined, checking: boolean): string {
  if (!check) return checking ? 'Checking' : 'Not checked yet'
  if (check.ok && check.warning) return 'Passed with a warning'
  return check.ok ? 'Passed' : 'Failed'
}

export function CheckStatusIcon({
  check,
  checking,
  srWord = true,
  iconOverride,
  wordOverride
}: {
  check?: Check
  checking: boolean
  /** Set false by a caller that already renders the state word itself (HealthCheckDialog.tsx's
   *  showStateWord), so a screen reader hears it exactly once instead of twice. */
  srWord?: boolean
  /** Spec 006: forces the neutral (never-alarming) icon regardless of check.ok -- the optional
   *  GitHub CLI row ('not set up'/'signed out' is never a hard failure) and the whole-check-
   *  failed state both use this instead of the destructive red X. */
  iconOverride?: 'neutral'
  /** Spec 006: replaces the word a screen reader hears (and, via the caller's own showStateWord
   *  rendering, the visible word too) -- e.g. 'Optional, not set up' instead of the generic
   *  'Failed'. */
  wordOverride?: string
}): ReactNode {
  const word = wordOverride ?? checkStateWord(check, checking)
  if (iconOverride === 'neutral') {
    return (
      <>
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        {srWord && <span className="sr-only">{word}</span>}
      </>
    )
  }
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
  /** Spec 006 quality-gate remediation: see the file header comment. */
  iconOverride?: 'neutral'
  wordOverride?: string
  hideHint?: boolean
  contentRef?: Ref<HTMLDivElement>
}

export function CheckRow({
  label,
  check,
  checking,
  showStateWord = false,
  action,
  progress,
  iconOverride,
  wordOverride,
  hideHint = false,
  contentRef
}: CheckRowProps) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckStatusIcon
        check={check}
        checking={checking}
        srWord={!showStateWord}
        iconOverride={iconOverride}
        wordOverride={wordOverride}
      />
      <div ref={contentRef} tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">
            {label}
            {showStateWord && (
              <span className="whitespace-nowrap text-muted-foreground"> — {wordOverride ?? checkStateWord(check, checking)}</span>
            )}
          </span>
          {action}
        </div>
        {check?.found && <span className="text-xs text-muted-foreground">{check.found}</span>}
        {!hideHint && check && !check.ok && check.hint && <span className="text-xs text-destructive">{check.hint}</span>}
        {check && check.ok && check.warning && check.hint && <span className="text-xs text-state-needs-you">{check.hint}</span>}
        {progress}
      </div>
    </li>
  )
}
