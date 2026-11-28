import * as React from 'react'
import { numberSessionStages, reuseStageNumbers, type StageNumbers } from '../subagents/viewModel/numbering'
import { selectSubagentItems } from '../subagents/viewModel/selectors'
import type { SubagentSummary, TranscriptItem } from '../../../shared/model'

/**
 * The Session's Stage numbers from the whole transcript, not the visible window, so a Stage keeps its number when earlier turns are
 * windowed out. The previous map is kept in a ref written after commit, so a rebuild that changed nothing returns the same map and
 * the memos keyed on it hold.
 */
export function useSessionStageNumbers(items: readonly TranscriptItem[], summaries: readonly SubagentSummary[]): StageNumbers {
  const next = React.useMemo(() => numberSessionStages(selectSubagentItems(items), summaries), [items, summaries])
  const previousRef = React.useRef<StageNumbers | undefined>(undefined)
  const stable = reuseStageNumbers(previousRef.current, next)
  React.useEffect(() => {
    previousRef.current = stable
  }, [stable])
  return stable
}
