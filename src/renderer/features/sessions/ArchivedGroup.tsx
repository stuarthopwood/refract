import { ArchiveIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { useSessionListStore, useSplitStore } from '@/state'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { GROUP_HEADER_ACTIONS_WIDTH_PX, GroupHeaderTrigger } from './GroupHeader'
import { groupWaitingState } from './sessionDisplay'
import { SessionRow } from './SessionRow'

export function ArchivedGroup({
  sessions,
  repositoriesById
}: {
  sessions: SessionSummary[]
  repositoriesById: Map<string, Repository>
}) {
  const rows = sessions.filter((session) => repositoriesById.has(session.repositoryId))
  const sorted = [...rows].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const isOpen = useSessionListStore((state) => state.isArchivedGroupOpen())
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
          <div aria-hidden className="shrink-0" style={{ width: GROUP_HEADER_ACTIONS_WIDTH_PX }} />
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
