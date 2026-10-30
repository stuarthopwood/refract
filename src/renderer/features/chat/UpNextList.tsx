import { useId } from 'react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useTodoPinStore } from '@/state'

export function UpNextList({ sessionId, stagesCount, isLastTurn }: { sessionId: string | null; stagesCount: number; isLastTurn: boolean }) {
  const todoPhases = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.todoPhases : null))
  const pinned = useTodoPinStore((s) => (sessionId ? (s.pinnedBySession[sessionId] ?? false) : false))
  const headingId = useId()
  if (!isLastTurn || stagesCount === 0 || !todoPhases || todoPhases.length === 0 || pinned) return null
  return (
    <div aria-live="off" className="mt-6 px-2 text-xs text-muted-foreground">
      <span id={headingId} className="font-medium">
        Up next
      </span>
      <ul aria-labelledby={headingId} className="mt-1 space-y-1">
        {todoPhases.map((phase, index) => (
          <li key={`${phase.name}-${index}`}>
            {phase.name} {'\u00b7'} {phase.pendingCount} task{phase.pendingCount === 1 ? '' : 's'}
          </li>
        ))}
      </ul>
    </div>
  )
}
