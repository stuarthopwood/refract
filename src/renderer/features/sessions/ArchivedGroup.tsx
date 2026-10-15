import { ArchiveIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { GroupHeaderTrigger } from './GroupHeader'
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
  if (rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  return (
    <div className="flex flex-col" data-archived-group="">
      <Collapsible>
        <div className="flex items-center gap-1 px-1">
          <GroupHeaderTrigger label={`Archived (${sorted.length})`} icon={ArchiveIcon} />
        </div>
        <CollapsibleContent>
          <ul aria-label="Archived sessions" className="flex flex-col gap-0.5 py-1">
            {sorted.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                // Non-null: `rows` above already filtered to sessions with a resolvable repository.
                repository={repositoriesById.get(session.repositoryId)!}
                showRepository
              />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
