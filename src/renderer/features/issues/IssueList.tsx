// The Issues list column (issue #504, spec 051): the shared `ProjectListPane` (Filter tabs, Filters
// toggle, search, State, Project, summary, skipped disclosure, empty state) plus Issues' own Label
// filter and rows.
import { useEffect } from 'react'
import { ColourDot } from '@/components/ColourDot'
import { FILTER_PICKER_CLASS, ProjectListPane } from '@/components/ProjectListPane'
import { MultiSelectChecklist } from '@/components/MultiSelectChecklist'
import { Badge } from '@/components/ui/badge'
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

function labelSummary(labels: string[]): string {
  if (labels.length === 0) return 'Any label'
  return labels.length === 1 ? (labels[0] ?? '') : ` labels`
}

export function IssueList() {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const store = useIssuesStore()

  const allIds = repositories.map((repo) => repo.id)
  const allIdsKey = allIds.join('|')
  const scopeIds = store.repositoryIds.length > 0 ? store.repositoryIds : allIds
  const labelOptions = useIssueLabelOptions(scopeIds, store.labels)
  const { refresh } = store

  // Fetches on open and on every filter change; never polled (spec 051).
  useEffect(() => {
    void refresh(allIds)
    // `allIds` is covered by `allIdsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.tab, store.state, store.repositoryIds, store.labels, allIdsKey, refresh])

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
      extraActiveCount={store.labels.length > 0 ? 1 : 0}
      blurWhileLoading
      extraFilters={
        <MultiSelectChecklist
          label="Label"
          summary={labelSummary(store.labels)}
          options={labelOptions.map((label) => ({
            value: label.name,
            label: label.name,
            leading: <ColourDot color={label.color} />
          }))}
          selected={store.labels}
          onChange={(next) => {
            const changed = next.length > store.labels.length ? next.find((n) => !store.labels.includes(n)) : store.labels.find((n) => !next.includes(n))
            if (changed !== undefined) store.toggleLabel(changed)
          }}
          className={FILTER_PICKER_CLASS}
        />
      }
      filterChips={
        store.labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {store.labels.map((name) => (
              <Badge key={name} variant="secondary" onDismiss={() => store.removeLabel(name)} dismissLabel={`Remove label filter ${name}`}>
                {name}
              </Badge>
            ))}
          </div>
        )
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