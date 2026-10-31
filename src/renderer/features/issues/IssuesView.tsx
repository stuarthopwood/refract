// The top-level Issues view (issue #504, spec 051): a cross-Project GitHub issues browser. The
// shared `ScreenHeader` over the shared `ListDetailSplit` (filterable list beside the selected
// issue's detail). "New issue" reuses the Report an issue dialog (#503) for one Project.
import { useEffect, useRef, useState } from 'react'
import { PlusIcon } from 'lucide-react'
import { ListDetailSplit } from '@/components/ListDetailSplit'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Button } from '@/components/ui/button'
import { ReportIssueDialog } from '@/features/sessions/ReportIssueDialog'
import { useDefaultRepositoryId } from '@/lib/defaultRepository'
import { useIssuesStore, useRepositoriesStore, useViewStore } from '@/state'
import { IssueDetail } from './IssueDetail'
import { IssueList } from './IssueList'

export function IssuesView({ reservesWindowControls = true }: { reservesWindowControls?: boolean }) {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const openChat = useViewStore((s) => s.openChat)
  const selected = useIssuesStore((s) => s.selected)
  const chosenIds = useIssuesStore((s) => s.repositoryIds)
  const defaultRepositoryId = useDefaultRepositoryId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const newIssueRef = useRef<HTMLButtonElement>(null)
  const createdIssueRef = useRef(false)
  const [newIssueOpen, setNewIssueOpen] = useState(false)

  // Lands keyboard and screen-reader users on the view instead of the nav button just activated.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // The Project a new issue goes to: the one chosen in the filter, else the selected issue's, else the default.
  const targetId = chosenIds.length === 1 ? chosenIds[0] : (selected?.repositoryId ?? defaultRepositoryId)
  const target = repositories.find((repo) => repo.id === targetId) ?? repositories[0]

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScreenHeader
        title="Issues"
        headingRef={headingRef}
        backLabel="Back to chat"
        onBack={() => openChat()}
        reservesWindowControls={reservesWindowControls}
      >
        {target && (
          <Button ref={newIssueRef} type="button" variant="outline" size="sm" onClick={() => setNewIssueOpen(true)}>
            <PlusIcon aria-hidden className="size-4" />
            New issue
          </Button>
        )}
      </ScreenHeader>
      {repositories.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Add a project to browse its issues.
        </div>
      ) : (
        <ListDetailSplit
          idPrefix="issues"
          resizeLabel="Resize issue list"
          list={<IssueList />}
          detail={
            selected ? (
              <IssueDetail key={`${selected.repositoryId}#${selected.number}`} repositoryId={selected.repositoryId} number={selected.number} />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                Select an issue to view its details.
              </div>
            )
          }
        />
      )}
      {target && (
        <ReportIssueDialog
          repository={target}
          open={newIssueOpen}
          onOpenChange={setNewIssueOpen}
          onCloseFocus={() => {
            // After a create, land on the new issue's row when it is listed, else the New issue button.
            const row = createdIssueRef.current ? document.querySelector<HTMLElement>('[data-issue-row][aria-current="true"]') : null
            createdIssueRef.current = false
            ;(row ?? newIssueRef.current)?.focus()
          }}
          title="New issue"
          onCreated={(issue) => {
            const store = useIssuesStore.getState()
            const allIds = repositories.map((repo) => repo.id)
            createdIssueRef.current = true
            // A new issue is open, unlabelled and in the target Project; clear filters that would hide it.
            const hidden =
              store.state === 'closed' ||
              store.labels.length > 0 ||
              store.appliedQuery.trim() !== '' ||
              store.tab === 'assigned' ||
              store.tab === 'mentions' ||
              (store.repositoryIds.length > 0 && !store.repositoryIds.includes(target.id))
            if (hidden) {
              store.clearFilters()
              store.setTab('all')
            }
            store.select({ repositoryId: target.id, number: issue.number })
            // Cleared filters refetch through the list's effect; otherwise refetch here, submitted search only.
            if (!hidden) void store.refresh(allIds, true)
          }}
        />
      )}
    </div>
  )
}
