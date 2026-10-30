import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { notify, useSessionsStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import { canResumeSession, resumeSession, stillEligibleAfterResume } from '@/features/chat/resume'
import { describeStopReason } from '@/features/chat/ChatPane'

// Issue #509 (PLAN.md row A2g): icon-only, row-level Resume -- recovers the agent and sends the
// default resume instruction as a real turn (`resumeSession`, shared with ChatPane's own Resume
// button in the stop banner; `sessions.resume` itself holds the server-side single-flight
// lock, so the ref below only ever blocks this one button's own double click). aria-disabled, not
// `disabled`, so keyboard focus stays on the button through the call.
// Moved unchanged out of `useSessionRowActions.ts` (#934) to keep that file under the 600-line cap.
export function useSessionResume(
  session: SessionSummary,
  openButtonRef: RefObject<HTMLButtonElement | null>,
  focusListContainer: () => void
) {
  const [resuming, setResuming] = useState(false)
  const resumingRef = useRef(false)
  const resumeButtonRef = useRef<HTMLButtonElement>(null)
  // Issue #509 quality-gate fix: a successful resume flips `canResume` false on this row's
  // next render (its own button then disappears) -- without this, focus that was on the
  // button at click time would silently fall back to <body> (WCAG 2.1 AA focus-visibility).
  const resumeFocusPendingRef = useRef(false)

  // Gate-fixes a11y Low finding (cycle 5): a Session mid-start after a Recover of an
  // `agent-exited` Session kept this true, showing an enabled Resume button next to this row's
  // own "Starting agent… N s" text -- ChatPane's banner already hides its own Resume for this
  // same state (`showBanner` requires `!startProgress`); this row disagreed.
  const canResume = !session.startProgress && canResumeSession(session.status, session.stopReason, session.terminatedUnexpectedly, !!session.archivedAt)

  // Quality-gate fix (cycle 2, 2026-10-08): only moves focus when it is actually stranded
  // (<body>, null, or disconnected) -- previously this ran unconditionally the instant
  // `canResume` flipped false, which could yank focus back to this row even if the user had
  // since tabbed away (or clicked elsewhere) during the call, matching `ChatPane.tsx`'s own
  // `maybeRestoreFocus` "stranded" test for its Recover/Retry buttons.
  useEffect(() => {
    if (canResume || !resumeFocusPendingRef.current) return
    resumeFocusPendingRef.current = false
    const active = document.activeElement
    const stranded = !active || active === document.body || !active.isConnected
    if (!stranded) return
    if (openButtonRef.current?.isConnected) openButtonRef.current.focus()
    else focusListContainer()
  }, [canResume])

  async function handleResume(): Promise<void> {
    if (resumingRef.current) return
    resumingRef.current = true
    if (document.activeElement === resumeButtonRef.current) resumeFocusPendingRef.current = true
    setResuming(true)
    // Issue #603 quality-gate follow-up (Low, availability): wraps the call in try/finally --
    // an unhandled rejection from `resumeSession` (the preload bridge call itself, not an
    // `{ ok: false }` result) used to leave `resumingRef`/`setResuming` stuck true forever,
    // locking this row's Resume button for the rest of the session.
    try {
      const result = await resumeSession(session.id)
      // Quality-gate fix (cycle 5, 2026-10-08): `sessions.resume` can return `ok: true` with a
      // STILL-stopped snapshot when the restart itself failed (e.g. start-failed) --
      // `resumeSession.ts`'s own doc comment. Previously only `!result.ok` counted as a failure
      // here (WCAG 4.1.3, 3.3.1). The banner's own `role="alert"` title change already
      // announces this from the pane; the row had no equivalent.
      const restartFailed = result.ok && result.value.runtime.status === 'stopped'
      if (!result.ok || restartFailed) {
        // Quality-gate fix (cycle 7, 2026-10-08, a11y-auditor, Medium): only clear the pending
        // flag when the Session is STILL resumable after this call -- a restart failure (ok:true,
        // still stopped, now e.g. stopReason:'start-failed') flips `canResume` to false exactly
        // like a genuine success does, so the effect above still needs to run and move focus onto
        // the open button once the Resume button disappears.
        const stillEligible = stillEligibleAfterResume(result, !!session.archivedAt)
        if (stillEligible) resumeFocusPendingRef.current = false
        notify(
          result.ok
            ? { code: 'invalid-argument', message: describeStopReason(result.value.runtime.stopReason, result.value.runtime.stopDetail) }
            : result.error
        )
      }
    } catch (err) {
      // Issue #603 quality-gate follow-up (Low, a11y) round 2: reads the freshest store state
      // (never the `session` prop this closure captured, now possibly stale) and only clears
      // the pending flag when the Session is STILL resumable -- otherwise leaves it armed, since
      // the rejection may have landed after the restart actually succeeded server-side.
      const latest = useSessionsStore.getState().sessions.find((s) => s.id === session.id)
      if (latest && canResumeSession(latest.status, latest.stopReason, latest.terminatedUnexpectedly, !!latest.archivedAt)) {
        resumeFocusPendingRef.current = false
      }
      notify({ code: 'reattach-failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      resumingRef.current = false
      setResuming(false)
    }
  }

  return { resuming, resumeButtonRef, canResume, handleResume }
}
