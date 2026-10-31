import { usePinnedPanelsStore, usePullRequestsStore, useViewStore } from '@/state'
import { Button } from '@/components/ui/button'
import { PinnedPanelShell } from '@/components/PinnedPanelShell'
import { PullRequestDetail } from '@/features/pull-requests/PullRequestDetail'

/** The pinned Pull request panel: the detail view in a compact layout plus a jump to the full view. */
export function PinnedPullRequestPanel({ sessionId }: { sessionId: string | null }) {
  const target = usePinnedPanelsStore((s) => s.pullRequest)
  return (
    <PinnedPanelShell
      target={target}
      activeSessionId={sessionId}
      emptyText="No pull request selected."
      toolbar={
        target && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              usePullRequestsStore.getState().openPullRequest(target.repositoryId, target.number)
              useViewStore.getState().openPullRequests()
            }}
          >
            Open in Pull requests view
          </Button>
        )
      }
    >
      {target && <PullRequestDetail key={`${target.repositoryId}:${target.number}`} repositoryId={target.repositoryId} number={target.number} compact />}
    </PinnedPanelShell>
  )
}
