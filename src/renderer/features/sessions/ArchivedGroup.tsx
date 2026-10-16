import { ArchiveIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { useSessionListStore, useSplitStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { GROUP_HEADER_ACTIONS_OFFSET_PX, GroupHeaderTrigger } from './GroupHeader'
import { groupWaitingState } from './sessionDisplay'
import { SessionRow } from './SessionRow'

// Issue #527 (UX consult decisions 1-4): one cross-repository Archived group at the very bottom
// of the list, a flat list (not sub-grouped by repository -- each row shows its own repository
// name instead), collapsed by default, hidden entirely while nothing anywhere is archived.
export function ArchivedGroup({
  sessions,
  repositoriesById
}: {
  sessions: SessionSummary[]
  repositoriesById: Map<string, Repository>
}) {
  // Gate round 1 fix (code-reviewer, Low): counts and renders only rows whose repository is
  // actually still resolvable -- the invariant (no Session may outlive its own Repository) holds
  // in practice, but the header's own count must never silently disagree with what the list
  // below it actually shows if that invariant is ever violated transiently (for example mid-
  // store-update).
  const rows = sessions.filter((session) => repositoriesById.has(session.repositoryId))
  const sorted = [...rows].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  // #735 decisions 15-17: the persisted open/closed state (replaces the previous uncontrolled,
  // always-closed-by-default Collapsible), the Waiting marker and the visible-Session active bar
  // -- both only shown while closed (decisions 21, 22). Hooks run
  // unconditionally, ABOVE the `rows.length === 0` early return below (Rules of Hooks) --
  // `sorted` is simply `[]` on that pass, which every selector/helper below already handles.
  const isOpen = useSessionListStore((state) => state.archivedOpen)
  const containsVisibleSession = useSplitStore((state) => sorted.some((session) => state.paneSessionIds.includes(session.id)))
  const marker = isOpen ? null : groupWaitingState(sorted)
  const containsOpenSession = !isOpen && containsVisibleSession
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col" data-archived-group="">
      <Collapsible open={isOpen} onOpenChange={(open) => useSessionListStore.getState().setArchivedOpen(open)}>
        <div className="group flex items-center gap-1 px-1">
          <GroupHeaderTrigger
            label="Archived"
            count={sorted.length}
            icon={ArchiveIcon}
            marker={marker}
            containsOpenSession={containsOpenSession}
          />
          {/* Gate round 1 fix (Low, ui-traversal-layout-v3): Archived has no action buttons of
              its own, so without this spacer the trigger's `ml-auto` marker would land further
              right than every Repository header's own marker (which shares its row with
              `GROUP_HEADER_ACTIONS_OFFSET_PX`'s worth of buttons), breaking decision 21's "one
              column" rule. */}
          <div aria-hidden className="shrink-0" style={{ width: GROUP_HEADER_ACTIONS_OFFSET_PX }} />
        </div>
        <CollapsibleContent>
          <ul aria-label="Archived sessions" className="flex flex-col gap-0 py-1">
            {sorted.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                // Non-null: `rows` above already filtered to sessions with a resolvable repository.
                repository={repositoriesById.get(session.repositoryId)!}
              />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
