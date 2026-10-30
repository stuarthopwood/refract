// The Issues list column (issue #504, spec 051): the shared `ProjectListPane` (Filter tabs, Filters
// toggle, search, State, Project, summary, skipped disclosure, empty state) plus Issues' own Label
// filter and rows.
import { useEffect } from 'react'
import { ColourDot } from '@/components/ColourDot'
import { ProjectListPane } from '@/components/ProjectListPane'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useIssuesStore, useRepositoriesStore } from '@/state'
import type { IssueTab } from '../../../shared/ipc-issues'
import { IssueRow } from './IssueRow'
import { useIssueLabelOptions } from './useIssueLabelOptions'

const TABS: Array<{ value: IssueTab; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'authored', label: 'Authored by me' },
  { value: 'mentions', label: 'Mentions me' }
]

// Radix Select forbids an empty-string item value, so "any label" gets a sentinel.
const ANY_LABEL = '__any__'

export function IssueList() {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const store = useIssuesStore()

  const allIds = repositories.map((repo) => repo.id)
  const allIdsKey = allIds.join('|')
  const scopeIds = store.repositoryIds.length > 0 ? store.repositoryIds : allIds
  const labelOptions = useIssueLabelOptions(scopeIds, store.label)
  const { refresh } = store

  // Fetches on open and on every filter change; never polled (spec 051).
  useEffect(() => {
    void refresh(allIds)
    // `allIds` is covered by `allIdsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.tab, store.state, store.repositoryIds, store.label, allIdsKey, refresh])

  return (
    <ProjectListPane
      noun={{ singular: 'issue', plural: 'issues' }}
      idPrefix="issue"
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
      onRefresh={() => void refresh(allIds)}
      onClearFilters={store.clearFilters}
      extraActiveCount={store.label !== null ? 1 : 0}
      extraFilters={
        <Select value={store.label ?? ANY_LABEL} onValueChange={(value) => store.setLabel(value === ANY_LABEL ? null : value)}>
          <SelectTrigger aria-label="Label" className="min-w-0 max-w-44 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={ANY_LABEL}>Any label</SelectItem>
            {labelOptions.map((label) => (
              <SelectItem key={label.name} value={label.name}>
                <span className="flex items-center gap-2">
                  <ColourDot color={label.color} />
                  {label.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      loading={store.loading}
      fetchedAt={store.fetchedAt}
      error={store.error}
      skipped={store.skipped}
      itemCount={store.items.length}
      projectCount={new Set(store.items.map((issue) => issue.repositoryId)).size}
    >
      {store.items.map((issue) => (
        <IssueRow
          key={`${issue.repositoryId}#${issue.number}`}
          issue={issue}
          selected={store.selected?.repositoryId === issue.repositoryId && store.selected.number === issue.number}
          onSelect={() => store.select({ repositoryId: issue.repositoryId, number: issue.number })}
        />
      ))}
    </ProjectListPane>
  )
}