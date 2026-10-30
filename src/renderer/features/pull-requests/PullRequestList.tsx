// The Pull requests list column (issue #874, spec 057): the shared `ProjectListPane` plus the
// pull request tabs, paging and rows. Cross-Project, like the Issues list.
import { useEffect } from 'react'
import { ProjectListPane } from '@/components/ProjectListPane'
import { MAX_ROWS } from '@/state/pull-requests-store'
import { useAccountsStore, usePullRequestsStore, useRepositoriesStore } from '@/state'
import type { FilterTab } from '../../../shared/github'
import { PullRequestRow } from './PullRequestRow'

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
  const store = usePullRequestsStore()
  const { refresh, loadMore, limit } = store

  const allIds = repositories.map((repo) => repo.id)
  const allIdsKey = allIds.join('|')

  // Fetches on open and on every filter change; never polled. A search applies on Enter, which
  // calls the Refresh below.
  useEffect(() => {
    void refresh(allIds)
    // `allIds` is covered by `allIdsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.tab, store.state, store.repositoryIds, allIdsKey, refresh])

  return (
    <ProjectListPane
      noun={{ singular: 'pull request', plural: 'pull requests' }}
      idPrefix="pull-request"
      tabs={TABS}
      tab={store.tab}
      onTabChange={store.setTab}
      state={store.state}
      onStateChange={store.setState}
      projects={repositories.map((repo) => ({ id: repo.id, name: repo.name }))}
      repositoryIds={store.repositoryIds}
      onRepositoryIdsChange={store.setRepositoryIds}
      query={store.query}
      appliedQuery={store.appliedQuery}
      onQueryChange={store.setQuery}
      onRefresh={() => {
        void refresh(allIds)
        // Issue #569: an explicit Refresh also refreshes the sidebar count for the Projects shown.
        if (githubStatus === 'ready') {
          const scope = store.repositoryIds.length > 0 ? store.repositoryIds : allIds
          for (const id of scope) void store.refreshActiveCount(id)
        }
      }}
      onClearFilters={store.clearFilters}
      loading={store.loading}
      fetchedAt={store.fetchedAt}
      error={store.error}
      skipped={store.skipped}
      itemCount={store.items.length}
      projectCount={new Set(store.items.map((pr) => pr.repositoryId)).size}
      paging={{
        hasMore: store.hasMore && limit < MAX_ROWS,
        atCap: store.hasMore && limit >= MAX_ROWS,
        cap: MAX_ROWS,
        onLoadMore: () => void loadMore(allIds)
      }}
    >
      {store.items.map((pr) => (
        <PullRequestRow
          key={`${pr.repositoryId}#${pr.number}`}
          pullRequest={pr}
          selected={store.selected?.repositoryId === pr.repositoryId && store.selected.number === pr.number}
          onSelect={() => store.select({ repositoryId: pr.repositoryId, number: pr.number })}
        />
      ))}
    </ProjectListPane>
  )
}
