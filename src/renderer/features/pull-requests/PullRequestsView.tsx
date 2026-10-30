// The top-level Pull requests view (issue #874, spec 057): a cross-Project pull request browser on
// the same shell as Issues: the shared `ScreenHeader` over the shared `ListDetailSplit` (the
// filterable list beside the selected pull request's detail).
import { useEffect, useRef } from 'react'
import { ListDetailSplit } from '@/components/ListDetailSplit'
import { ScreenHeader } from '@/components/ScreenHeader'
import { usePullRequestsStore, useRepositoriesStore, useViewStore } from '@/state'
import { PullRequestDetail } from './PullRequestDetail'
import { PullRequestList } from './PullRequestList'

export function PullRequestsView({ reservesWindowControls = true }: { reservesWindowControls?: boolean }) {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const openChat = useViewStore((s) => s.openChat)
  const selected = usePullRequestsStore((s) => s.selected)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Lands keyboard and screen-reader users on the view instead of the nav button just activated.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScreenHeader
        title="Pull requests"
        headingRef={headingRef}
        backLabel="Back to chat"
        onBack={() => openChat()}
        reservesWindowControls={reservesWindowControls}
      />
      {repositories.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Add a project to browse its pull requests.
        </div>
      ) : (
        <ListDetailSplit
          idPrefix="pull-requests"
          resizeLabel="Resize pull request list"
          list={<PullRequestList />}
          detail={
            selected ? (
              <PullRequestDetail key={`${selected.repositoryId}#${selected.number}`} repositoryId={selected.repositoryId} number={selected.number} />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                Select a pull request to view its details.
              </div>
            )
          }
        />
      )}
    </div>
  )
}
