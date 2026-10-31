import { usePinnedPanelsStore, usePullRequestsStore, useViewStore } from '@/state'
import { Button } from '@/components/ui/button'
import { PullRequestDetail } from '@/features/pull-requests/PullRequestDetail'

/** The pinned Pull request panel: the detail view in a compact layout plus a jump to the full view. */
export function PinnedPullRequestPanel() {
  const target = usePinnedPanelsStore((s) => s.pullRequest)
  if (!target) return <p className="p-4 text-sm text-muted-foreground">No pull request selected.</p>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="no-drag-region shrink-0 border-b px-2 py-2">
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
      </div>
      <div className="min-h-0 flex-1">
        <PullRequestDetail key={`${target.repositoryId}:${target.number}`} repositoryId={target.repositoryId} number={target.number} compact />
      </div>
    </div>
  )
}
