// Issue #941 part 2 (FR-079's deferred note): the muted "Up next" list below the Subagent chain
// -- the agent's own pending Todo phases (OMP `get_state().todoPhases`, name and outstanding
// task count), shown only while at least one phase still has outstanding work.
// `ReadoutState.todoPhases` (`src/shared/model.ts`) already carries ONLY the filtered, non-empty
// case on the wire: `compute_up_next` (`src-tauri/src/session/readout_todo.rs`) drops any phase
// with zero pending tasks and returns `null` outright once every phase would be empty, and is
// `None`/never re-populated for a reopened Conversation ("live state only", that same file's own
// comment) -- so this component needs no separate live-vs-history check of its own: `todoPhases`
// being non-null and non-empty already means "live, and something is still pending."
//
// Rendered once per TURN (not per Stage): `sessionId`-scoped readout state is the agent's own
// CURRENT todo list, not a per-turn snapshot, so showing it after every past turn with a Stage
// would repeat the identical list -- `isLastTurn` restricts it to the most recent turn only.
// `stagesCount === 0` also hides it: "below the Subagent chain" has no anchor point in a turn
// that never ran a `task()` call at all. A sibling of `SubagentChainRow` (`Transcript.tsx`), not
// nested inside its own collapsible content -- always visible regardless of whether the chain
// row itself is expanded or collapsed.
import { useId } from 'react'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'

export function UpNextList({ sessionId, stagesCount, isLastTurn }: { sessionId: string | null; stagesCount: number; isLastTurn: boolean }) {
  const todoPhases = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.todoPhases : null))
  // Gate round 1 fix (issue #941 part 2, item 4, HIGH): a labelled list (`useId`, the heading's
  // own `id`, `aria-labelledby` on the `<ul>`) -- a screen reader now reads "Up next, list, N
  // items" the moment focus or a linear read reaches it, not a bare, unnamed list.
  const headingId = useId()
  if (!isLastTurn || stagesCount === 0 || !todoPhases || todoPhases.length === 0) return null
  return (
    <div className="mt-6 px-2 text-xs text-muted-foreground">
      <span id={headingId} className="font-medium">
        Up next
      </span>
      <ul aria-labelledby={headingId} className="mt-1 space-y-0.5">
        {todoPhases.map((phase, index) => (
          <li key={`${phase.name}-${index}`}>
            {phase.name} {'\u00b7'} {phase.pendingCount} task{phase.pendingCount === 1 ? '' : 's'}
          </li>
        ))}
      </ul>
    </div>
  )
}
