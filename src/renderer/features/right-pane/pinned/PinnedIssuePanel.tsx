import { usePinnedPanelsStore } from '@/state'
import { PinnedPanelShell } from '@/components/PinnedPanelShell'
import { IssueDetail } from '@/features/issues/IssueDetail'

/** The pinned Issue panel: reuses the Issues page's detail view. */
export function PinnedIssuePanel({ sessionId }: { sessionId: string | null }) {
  const target = usePinnedPanelsStore((s) => s.issue)
  return (
    <PinnedPanelShell target={target} activeSessionId={sessionId} emptyText="No issue selected.">
      {target && <IssueDetail key={`${target.repositoryId}:${target.number}`} repositoryId={target.repositoryId} number={target.number} />}
    </PinnedPanelShell>
  )
}
