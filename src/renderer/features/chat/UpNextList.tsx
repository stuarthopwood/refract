// Issue #941 part 2 (FR-079's deferred note): the muted "Up next" list below a turn's last
// Stage -- the agent's own pending Todo phases (OMP `get_state().todoPhases`, name and
// outstanding task count), shown only while at least one phase still has outstanding work.
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
// `stagesCount === 0` also hides it: "below the last Stage" has no anchor point in a turn that
// never ran a `task()` call at all.
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'

export function UpNextList({ sessionId, stagesCount, isLastTurn }: { sessionId: string | null; stagesCount: number; isLastTurn: boolean }) {
  const todoPhases = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.todoPhases : null))
  if (!isLastTurn || stagesCount === 0 || !todoPhases || todoPhases.length === 0) return null
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      <span className="font-medium">Up next</span>
      <ul className="mt-1 space-y-0.5">
        {todoPhases.map((phase) => (
          <li key={phase.name}>
            {phase.name} · {phase.pendingCount} tasks
          </li>
        ))}
      </ul>
    </div>
  )
}
