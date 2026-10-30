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
  const resumeFocusPendingRef = useRef(false)

  // Gate-fixes a11y Low finding (cycle 5): a Session mid-start after a Recover of an
  // `agent-exited` Session kept this true, showing an enabled Resume button next to this row's
  // own "Starting agent… N s" text -- ChatPane's banner already hides its own Resume for this
  // same state (`showBanner` requires `!startProgress`); this row disagreed.
  const canResume = !session.startProgress && canResumeSession(session.status, session.stopReason, session.terminatedUnexpectedly, !!session.archivedAt)

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
    try {
      const result = await resumeSession(session.id)
      const restartFailed = result.ok && result.value.runtime.status === 'stopped'
      if (!result.ok || restartFailed) {
        const stillEligible = stillEligibleAfterResume(result, !!session.archivedAt)
        if (stillEligible) resumeFocusPendingRef.current = false
        notify(
          result.ok
            ? { code: 'invalid-argument', message: describeStopReason(result.value.runtime.stopReason, result.value.runtime.stopDetail) }
            : result.error
        )
      }
    } catch (err) {
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
