// Which Sessions the low-memory Triage dialog may stop (FR-037, #1890).

import type { SessionSummary } from '../../../shared/ipc'

type TriageSession = Pick<SessionSummary, 'status' | 'archivedAt' | 'pause'>

/** A paused Session that finished its turn is idle too, but Stop would undo a pause the user set on purpose. */
export function isIdleStoppable(session: TriageSession): boolean {
  return session.status === 'idle' && !session.archivedAt && !session.pause
}

/** Idle Sessions Triage leaves out because they are paused; the dialog says how many. */
export function countPausedIdle(sessions: readonly TriageSession[]): number {
  return sessions.filter((session) => session.status === 'idle' && !session.archivedAt && session.pause).length
}
