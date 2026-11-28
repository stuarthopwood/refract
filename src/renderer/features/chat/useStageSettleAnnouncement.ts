import * as React from 'react'
import { useClearedAnnouncement } from '../../lib/use-cleared-announcement'
import type { StageGroup } from './groupSubagentStages'

/** Stage id to whether it was seen running; a Stage absent from the map has never been seen. */
export type StageRunningMap = ReadonlyMap<string, boolean>

export interface StageSettleResult {
  /** Text for the Stage that settled in this pass; the last one when several did. Undefined when none did. */
  announcement: string | undefined
  /** What to remember for the next pass: only the Stages now visible, so one that left the window and returns is a first sighting. */
  seen: Map<string, boolean>
}

/**
 * A Stage settles when it was seen running and now is not. A Stage first seen already settled never announces, so loading history is
 * silent. Pure, so the rule is tested without rendering.
 */
export function detectStageSettle(prevSeen: StageRunningMap, stages: readonly StageGroup[]): StageSettleResult {
  const seen = new Map<string, boolean>()
  let lastSettled: StageGroup | undefined
  for (const stage of stages) {
    const running = stage.items.some((item) => item.status === 'running')
    if (prevSeen.get(stage.id) === true && !running) lastSettled = stage
    seen.set(stage.id, running)
  }
  return { announcement: lastSettled && `Stage ${lastSettled.stageIndex} finished, ${lastSettled.view.rollupText}`, seen }
}

// One announcer for the whole transcript, mounted outside the `role="log"`: a status inside it would be announced twice. It reads
// unfiltered stages so a Stage hidden by "Show tool calls" off still announces.
export function useStageSettleAnnouncement(stages: readonly StageGroup[]): string {
  // Clear-then-set so identical consecutive texts still re-announce.
  const [stageAnnouncement, announce] = useClearedAnnouncement()
  const seenRef = React.useRef<StageRunningMap>(new Map())
  React.useEffect(() => {
    const { announcement, seen } = detectStageSettle(seenRef.current, stages)
    seenRef.current = seen
    if (announcement) announce(announcement)
  }, [stages, announce])
  return stageAnnouncement
}
