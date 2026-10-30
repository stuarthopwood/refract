import { useEffect, useRef } from 'react'
import { useSessionsStore } from '@/state/sessions-store'
import type { SessionStartProgress } from '../../../shared/model'

const STARTING_PLACEHOLDER: SessionStartProgress = { kind: 'waiting', elapsedMs: 0 }

/** Issue #1205 (FR-106): */
export function useEffectiveStartProgress(
  sessionId: string,
  status: string | undefined,
  startProgress: SessionStartProgress | undefined
): SessionStartProgress | undefined {
  const isStarting = useSessionsStore((s) => s.startingIds.has(sessionId))
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
