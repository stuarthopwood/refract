import { usePinnedPanelsStore } from '@/state'
import { IssueDetail } from '@/features/issues/IssueDetail'

/** The pinned Issue panel: reuses the Issues page's detail view. */
export function PinnedIssuePanel() {
  const target = usePinnedPanelsStore((s) => s.issue)
  if (!target) return <p className="p-4 text-sm text-muted-foreground">No issue selected.</p>
  return (
    <div className="min-h-0 flex-1">
      <IssueDetail key={`${target.repositoryId}:${target.number}`} repositoryId={target.repositoryId} number={target.number} />
    </div>
  )
}
