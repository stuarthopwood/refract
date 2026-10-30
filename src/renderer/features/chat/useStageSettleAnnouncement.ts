import * as React from 'react'
import { useClearedAnnouncement } from '../../lib/use-cleared-announcement'
import type { StageGroup } from './groupSubagentStages'
import { stageSettleSummary } from './subagentChainStatus'

interface TurnWithStages {
  stages: StageGroup[]
}

// A single out-of-log announcer (not per-row, which double-announces inside role="log"). It reads
// unfiltered stages so a Stage hidden by "Show tool calls" off still announces (#563).
export function useStageSettleAnnouncement(turnsWithStages: readonly TurnWithStages[]): string {
  // Clear-then-set so identical consecutive texts still re-announce.
  const [stageAnnouncement, announce] = useClearedAnnouncement()
  // Stage id -> seen running. A first-seen Stage never announces (nothing while history loads).
  const stageRunningRef = React.useRef<Map<string, boolean>>(new Map())
  React.useEffect(() => {
    const seenIds = new Set<string>()
    let lastSettled: StageGroup | undefined
    for (const { stages } of turnsWithStages) {
      for (const stage of stages) {
        seenIds.add(stage.id)
        const running = stage.items.some((item) => item.status === 'running')
        const wasRunning = stageRunningRef.current.get(stage.id)
        if (wasRunning === true && !running) lastSettled = stage
        stageRunningRef.current.set(stage.id, running)
      }
    }
    // Drop Stages that left the visible window so a re-add is a first sighting, not a false settle.
    for (const id of stageRunningRef.current.keys()) {
      if (!seenIds.has(id)) stageRunningRef.current.delete(id)
    }
    // Only the last Stage settled in one pass is announced.
    if (lastSettled) announce(`Stage ${lastSettled.stageIndex} finished, ${stageSettleSummary(lastSettled)}`)
  }, [turnsWithStages, announce])
  return stageAnnouncement
}
