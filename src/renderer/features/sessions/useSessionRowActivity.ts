// #526 (FR-108, FR-110, US5/AC9): the Session row's Activity line text -- the same shared derive
// and hold as the current-work banner, fed by `SessionSummary.activity` (patched live from
// `session:activity`). Always passes the current todo: the todo pin affects the banner only.
import { useHeldActivityText, usePendingActivity } from '@/features/chat/useHeldActivityText'
import { deriveActivity } from '../../../shared/activity'
import type { SessionSummary } from '../../../shared/ipc'

/** `null` unless the Session is working or needs you ("Working…" until readout data arrives);
 * going idle or stopped clears at once, so line 2 reverts to the branch with no hold. */
export function useSessionRowActivity(session: SessionSummary): string | null {
  const pending = usePendingActivity(session.id)
  const needsYou = session.status === 'needs-you'
  const live = session.status === 'working' || needsYou
  const readout = session.activity ?? null
  const activity =
    live
      ? deriveActivity({
          needsYou,
          pending,
          runningSubagents: readout?.runningSubagents ?? 0,
          todo: readout?.todo ?? null,
          latestIntent: readout?.latestIntent,
          latestTool: readout?.latestTool,
          retry: readout?.retry,
          compacting: readout?.compacting
        })
      : null
  return useHeldActivityText(session.id, activity)
}
