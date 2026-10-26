// #526 (FR-110, spec 004 FR-041): the one hold-and-rotate hook behind both Activity surfaces --
// the current-work banner (`CurrentWorkBanner.tsx`) and the Session row's line 2
// (`SessionActivityLine.tsx`). Extracted from the banner's former private `useHeldText`, so the
// two surfaces can never pace or phrase the same activity differently.
import { useEffect, useRef, useState } from 'react'
import { usePendingRequestsStore, useSettingsStore } from '@/state'
import { playfulPhrase } from '../../../shared/activity'
import type { Activity, ActivityPending } from '../../../shared/activity'
import type { PendingRequest } from '../../../shared/model'

// Each line stays on screen at least this long, so it changes at most ~1.7 times a second.
const MIN_HOLD_MS = 600
// Playful: the `working` phrase rotates on this cadence.
const PLAYFUL_ROTATE_MS = 10_000

function toActivityPending(request: PendingRequest | undefined): ActivityPending | null {
  if (!request) return null
  if (request.kind === 'approval') return { kind: 'approval', tool: request.tool, target: request.target || null }
  if (request.kind === 'question') return { kind: 'question', text: request.title }
  const first = request.questions[0]
  return first ? { kind: 'question', text: first.question } : null
}

/** The Session's first pending request, reduced for `deriveActivity`'s needs-you line. */
export function usePendingActivity(sessionId: string): ActivityPending | null {
  const first = usePendingRequestsStore((s) => s.bySession[sessionId]?.[0])
  return toActivityPending(first)
}

function usePlayfulSlot(active: boolean): number {
  const [slot, setSlot] = useState(() => Math.floor(Date.now() / PLAYFUL_ROTATE_MS))
  useEffect(() => {
    if (!active) return
    setSlot(Math.floor(Date.now() / PLAYFUL_ROTATE_MS))
    const timer = setInterval(() => setSlot(Math.floor(Date.now() / PLAYFUL_ROTATE_MS)), PLAYFUL_ROTATE_MS)
    return () => clearInterval(timer)
  }, [active])
  return slot
}

/** `activity` null (idle, stopped, hidden) clears at once; any other change is held 600 ms. With
 * the "Activity text" setting on Playful, only the `working` kind is replaced by a per-Session
 * phrase that rotates every 10 s. */
export function useHeldActivityText(sessionId: string, activity: Activity | null): string | null {
  const playful = useSettingsStore((s) => s.settings.activityText === 'playful')
  const rotating = playful && activity?.kind === 'working'
  const slot = usePlayfulSlot(rotating)
  const next = activity === null ? null : rotating ? playfulPhrase(sessionId, slot) : activity.text
  const [shown, setShown] = useState(next)
  const shownAtRef = useRef(Date.now())
  useEffect(() => {
    if (next === shown) return
    const wait = next === null || shown === null ? 0 : Math.max(0, shownAtRef.current + MIN_HOLD_MS - Date.now())
    const timer = setTimeout(() => {
      shownAtRef.current = Date.now()
      setShown(next)
    }, wait)
    return () => clearTimeout(timer)
  }, [next, shown])
  return next === null ? null : shown
}
