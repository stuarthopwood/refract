// Extracted from `ChatPane.tsx` (issue #1205, a baseline-capped file): the start progress the
// "Starting agent" notice shows, including a placeholder stage for the gap before the first real
// `startProgress` event arrives.
import { useEffect, useRef } from 'react'
import { useSessionsStore } from '@/state/sessions-store'
import type { SessionStartProgress } from '../../../shared/model'

// Issue #618 gate-fix (code Low, round 3): a module-level constant, not a fresh object literal
// built on every render -- the returned value feeds a `useLayoutEffect` dependency array in
// `ChatPane.tsx`, so a new object every render would re-run that effect on every render.
const STARTING_PLACEHOLDER: SessionStartProgress = { kind: 'waiting', elapsedMs: 0 }

/** Issue #1205 (FR-106): the placeholder covers only a forced `open(id, true)` -- the one open
 * that actually starts an agent (`sessions-store.ts` `startingIds`). A passive open (a row click,
 * Ctrl+click into a Split, a notification click, a restored pane) only shows a stopped Session's
 * saved history and never shows the notice. */
export function useEffectiveStartProgress(
  sessionId: string,
  status: string | undefined,
  startProgress: SessionStartProgress | undefined
): SessionStartProgress | undefined {
  const isStarting = useSessionsStore((s) => s.startingIds.has(sessionId))
  // Issue #618 gate-fix (verif/code High, round 3): which Sessions have already shown a REAL
  // `startProgress` event during the CURRENT start span -- once one has, the placeholder never
  // reapplies for that span, even if `startProgress` briefly goes back to `undefined` before the
  // forced `open()` resolves (a winning Cancel, or the agent becoming ready). Cleared the instant
  // the start span ends, or the instant the pane switches to a DIFFERENT Session mid-span (round
  // 4: a Session left mid-span otherwise kept its entry and wrongly suppressed its next
  // placeholder).
  const realStartProgressSeenRef = useRef<Set<string>>(new Set())
  const effectiveStartProgress: SessionStartProgress | undefined =
    startProgress ??
    (isStarting && status === 'stopped' && !realStartProgressSeenRef.current.has(sessionId) ? STARTING_PLACEHOLDER : undefined)
  const prevSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prevId = prevSessionIdRef.current
    if (prevId !== null && prevId !== sessionId) realStartProgressSeenRef.current.delete(prevId)
    prevSessionIdRef.current = sessionId
    if (startProgress) realStartProgressSeenRef.current.add(sessionId)
    if (!isStarting) realStartProgressSeenRef.current.delete(sessionId)
  }, [startProgress, isStarting, sessionId])
  return effectiveStartProgress
}
