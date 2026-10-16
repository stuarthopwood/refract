import * as React from 'react'
import { useClearedAnnouncement } from '../../lib/use-cleared-announcement'
import type { AdvisoryGroupedTranscriptItem } from './groupAdvisoryItems'

interface TurnWithAdvisories {
  groupedWithStages: readonly AdvisoryGroupedTranscriptItem[]
}

const PREVIEW_LENGTH = 120

// Gate round 1 fix (High, three independent reviewers): a blocker's own announcement used to be
// a nested `aria-live="polite"` span rendered INSIDE `AdvisoryRow`, which sits inside the
// transcript's own `role="log"` (`aria-relevant="additions"`) -- a live arrival was read twice
// (once as the log's own addition, once by the nested region), and the mount-time effect fired
// again on every remount (a Session switch, a history reopen, "Load N earlier turns"), none of
// which `suppressLogAnnouncements` can silence (a nested live region is its own announcement
// channel, untouched by the parent's `aria-live="off"`). Moved into ONE out-of-log announcer,
// the same pattern `useStageSettleAnnouncement.ts` already uses for a Stage's own settle: reads
// every VISIBLE turn's own grouped items, keyed by blocker item id, and only announces an id
// that was NOT already present on this hook's own PREVIOUS pass -- so a id's first-ever sighting
// (history load or a fresh Session/Conversation mount) is recorded silently, never announced,
// matching `useStageSettleAnnouncement`'s own decision-21 "nothing while history loads" precedent,
// here via an explicit `null`-sentinel first pass rather than a running/not-running transition
// (a blocker item has no such transition to key off).
export function useAdvisoryAnnouncement(turnsWithStages: readonly TurnWithAdvisories[]): string {
  const [announcement, announce] = useClearedAnnouncement()
  const seenRef = React.useRef<Set<string> | null>(null)
  React.useEffect(() => {
    const seen = new Set<string>()
    let lastNew: { text: string } | undefined
    for (const { groupedWithStages } of turnsWithStages) {
      for (const item of groupedWithStages) {
        if (item.kind !== 'advisory' || item.severity !== 'blocker') continue
        seen.add(item.id)
        if (seenRef.current && !seenRef.current.has(item.id)) lastNew = { text: item.text }
      }
    }
    if (seenRef.current && lastNew) {
      const preview = lastNew.text.length > PREVIEW_LENGTH ? `${lastNew.text.slice(0, PREVIEW_LENGTH)}\u2026` : lastNew.text
      announce(`Blocker: ${preview}`)
    }
    seenRef.current = seen
  }, [turnsWithStages, announce])
  return announcement
}
