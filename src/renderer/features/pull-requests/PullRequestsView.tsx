// The top-level Pull requests view (specs/003-pull-request-management FR-001, T012): a
// repository dropdown over a two-column layout -- the filterable list (PullRequestList.tsx) and
// the selected pull request's detail (PullRequestDetail.tsx) -- scoped to the repository chosen
// here, written back to the shared `view-store.ts` so the choice survives switching away and
// back (research.md decision 7).
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usePullRequestsStore, useRepositoriesStore, useViewStore } from '@/state'
import { PullRequestList } from './PullRequestList'
import { PullRequestDetail } from './PullRequestDetail'

export function PullRequestsView() {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const viewRepositoryId = useViewStore((s) => s.repositoryId)
  const openPullRequests = useViewStore((s) => s.openPullRequests)
  const repositoryId = viewRepositoryId ?? repositories[0]?.id ?? null
  const selectedNumber = usePullRequestsStore((s) => s.stateFor(repositoryId ?? '').selectedNumber)

  if (!repositoryId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Add a repository to browse its pull requests.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Select value={repositoryId} onValueChange={(value) => openPullRequests(value)}>
          <SelectTrigger size="sm" aria-label="Repository" className="w-56">
            <SelectValue placeholder="Select a repository" />
          </SelectTrigger>
          <SelectContent>
            {repositories.map((repo) => (
              <SelectItem key={repo.id} value={repo.id}>
                {repo.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 overflow-hidden border-r border-border">
          <PullRequestList repositoryId={repositoryId} />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          {selectedNumber !== null ? (
            <PullRequestDetail repositoryId={repositoryId} number={selectedNumber} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              Select a pull request to view its details.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
