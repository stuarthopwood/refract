import * as React from 'react'
import { useClearedAnnouncement } from '../../lib/use-cleared-announcement'
import type { StageGroup } from './groupSubagentStages'
import { stageSettleSummary } from './SubagentChainRow'

interface TurnWithStages {
  stages: StageGroup[]
}

// Flow/Code gate fix (H3, #563 remediation round 4, 2026-10-15): the per-Stage "finished"
// announcement lives in a SINGLE out-of-log announcer -- the same pattern `Transcript.tsx`'s own
// `revealedAnnouncement` already uses -- instead of each `StageGroupRow` announcing itself from
// inside `MessageScrollerContent`'s own `role="log"` (announced twice there: once as a log
// addition, once as the status message). Reads every VISIBLE turn's UNFILTERED `stages` (not
// gated by `transcriptDisplay.toolCalls`), so a Stage hidden by "Show tool calls" off still gets
// its settle announced even though its own row never mounts. Split into its own file (code
// review, file-size baseline) so `Transcript.tsx` only ever carries the one-line hook call.
export function useStageSettleAnnouncement(turnsWithStages: readonly TurnWithStages[]): string {
  // Gate round 2 fix: two settles with byte-identical text (common across repeated gate rounds,
  // e.g. "Stage 1 finished, 3 agents" twice in a row) previously never re-announced -- a plain
  // `useState` set to the same string is a silent no-op, since nothing in the DOM actually
  // changes for a screen reader to notice. `useClearedAnnouncement` (the shared clear-then-set
  // helper) clears the text first and sets the real value on the next tick, forcing a genuine
  // DOM change every time.
  const [stageAnnouncement, announce] = useClearedAnnouncement()
  // Keyed by Stage id; `true` once a Stage has been observed with at least one `running` item.
  // Decision 21 ("nothing while history loads"): a Stage id seen for the very first time here is
  // never announced, however it settles -- only a later render that saw it running first, then
  // not running, counts as a genuine settle.
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
    // A Stage that scrolled out of the visible window (or whose turn's history was replaced)
    // drops out of the ref too, so a later re-add of the same id is a first sighting again, not
    // a false settle.
    for (const id of stageRunningRef.current.keys()) {
      if (!seenIds.has(id)) stageRunningRef.current.delete(id)
    }
    // If two or more Stages settle in the same pass, only the LAST one needs announcing (mirrors
    // `Transcript.tsx`'s own "only the last `'sr-only'` candidate" precedent).
    if (lastSettled) announce(`Stage ${lastSettled.stageIndex} finished, ${stageSettleSummary(lastSettled)}`)
  }, [turnsWithStages, announce])
  return stageAnnouncement
}
