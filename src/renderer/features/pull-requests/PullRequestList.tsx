// The Pull requests list column (issue #874, spec 057): the shared `ProjectListPane` plus the
// pull request tabs, paging and rows. Cross-Project, like the Issues list.
import { useEffect } from 'react'
import { ProjectListPane } from '@/components/ProjectListPane'
import { effectiveFilterQuery } from '@/components/filterQueryRule'
import { MAX_ROWS, sharesActiveCountSearch } from '@/state/pull-requests-store'
import { useAccountsStore, usePullRequestsStore, useRepositoriesStore } from '@/state'
import type { FilterTab } from '../../../shared/github'
import { NewSessionRowMenu } from '@/components/NewSessionRowMenu'
import { PullRequestRow } from './PullRequestRow'
import { stackKey } from './stack-view'
import { useStackMap } from './useStack'

const TABS: Array<{ value: FilterTab; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'authored', label: 'Authored by me' },
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'involves', label: 'Involves me' },
  { value: 'review-requested', label: 'Review requested' }
]

export function PullRequestList() {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const githubStatus = useAccountsStore((s) => s.githubStatus)
  const tab = usePullRequestsStore((s) => s.tab)
  const state = usePullRequestsStore((s) => s.state)
  const repositoryIds = usePullRequestsStore((s) => s.repositoryIds)
  const query = usePullRequestsStore((s) => s.query)
  const appliedQuery = usePullRequestsStore((s) => s.appliedQuery)
  const items = usePullRequestsStore((s) => s.items)
  const stackMap = useStackMap(items)
  const skipped = usePullRequestsStore((s) => s.skipped)
  const hasMore = usePullRequestsStore((s) => s.hasMore)
  const limit = usePullRequestsStore((s) => s.limit)
  const fetchedAt = usePullRequestsStore((s) => s.fetchedAt)
  const loading = usePullRequestsStore((s) => s.loading)
  const error = usePullRequestsStore((s) => s.error)
  const selected = usePullRequestsStore((s) => s.selected)
  // Store actions are stable, so reading them once never subscribes the list to the store.
  const { refresh, loadMore, setTab, setState, setRepositoryIds, setQuery, clearFilters, select, refreshActiveCount } =
    usePullRequestsStore.getState()

  const allIds = repositories.map((repo) => repo.id)
  const allIdsKey = allIds.join('|')

  // Fetches on open and on every filter change; never polled. A search applies on Enter, which
  // calls the Refresh below.
  useEffect(() => {
    void refresh(allIds)
    // `allIds` is covered by `allIdsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, state, repositoryIds, allIdsKey, refresh])

  return (
    <ProjectListPane
      noun={{ singular: 'pull request', plural: 'pull requests' }}
      idPrefix="pull-request"
      tabs={TABS}
      tab={tab}
      onTabChange={setTab}
      state={state}
      onStateChange={setState}
      projects={repositories.map((repo) => ({ id: repo.id, name: repo.name }))}
      repositoryIds={repositoryIds}
      onRepositoryIdsChange={setRepositoryIds}
      query={query}
      appliedQuery={appliedQuery}
      onQueryChange={setQuery}
      onRefresh={() => {
        void refresh(allIds)
        // An explicit Refresh also refreshes the sidebar count, unless this search already feeds it.
        if (githubStatus === 'ready' && !sharesActiveCountSearch({ tab, state, repositoryIds, query: effectiveFilterQuery(query), limit }, allIds)) {
          void refreshActiveCount(allIds)
        }
      }}
      onClearFilters={clearFilters}
      loading={loading}
      fetchedAt={fetchedAt}
      error={error}
      skipped={skipped}
      itemCount={items.length}
      projectCount={new Set(items.map((pr) => pr.repositoryId)).size}
      paging={{
        hasMore: hasMore && limit < MAX_ROWS,
        // At exactly 200 rows no 201st sets `hasMore`, so the row count marks the cap.
        atCap: limit >= MAX_ROWS && (hasMore || items.length >= MAX_ROWS),
        cap: MAX_ROWS,
        onLoadMore: () => void loadMore(allIds)
      }}
    >
      {items.map((pr) => (
        <NewSessionRowMenu
          key={`${pr.repositoryId}#${pr.number}`}
          item={{ kind: 'pull-request', repositoryId: pr.repositoryId, number: pr.number }}
          title={pr.title}
        >
          <PullRequestRow
            pullRequest={pr}
            selected={selected?.repositoryId === pr.repositoryId && selected.number === pr.number}
            stack={stackMap.get(stackKey(pr.repositoryId, pr.number))}
            onSelect={() => select({ repositoryId: pr.repositoryId, number: pr.number })}
          />
        </NewSessionRowMenu>
      ))}
    </ProjectListPane>
  )
}
