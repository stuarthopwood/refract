// The Issues list column (issue #504, spec 051): the shared `ProjectListPane` (Filter tabs, Filters
// toggle, search, State, Project, summary, skipped disclosure, empty state) plus Issues' own Label
// filter and rows.
import { useEffect, useRef } from 'react'
import { ColourDot } from '@/components/ColourDot'
import { FILTER_PICKER_CLASS, ProjectListPane } from '@/components/ProjectListPane'
import { MultiSelectChecklist } from '@/components/MultiSelectChecklist'
import { Badge } from '@/components/ui/badge'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useIssuesStore, useRepositoriesStore } from '@/state'
import type { IssueTab } from '../../../shared/ipc-issues'
import { NewSessionRowMenu } from '@/components/NewSessionRowMenu'
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
  return labels.length === 1 ? (labels[0] ?? '') : `${labels.length} labels`
}

export function IssueList() {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const store = useIssuesStore()
  const pillsRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<number | null>(null)

  // A dismissed pill unmounts its focused button: move focus to the next pill, else the previous, else the picker.
  const dismissLabel = (name: string) => {
    const index = store.labels.indexOf(name)
    pendingFocus.current = index < store.labels.length - 1 ? index : index - 1
    store.removeLabel(name)
    useChatAreaAnnouncer.getState().announce(`Removed label filter ${name}`)
  }
  useEffect(() => {
    if (pendingFocus.current === null) return
    const target = pendingFocus.current
    pendingFocus.current = null
    const buttons = pillsRef.current?.querySelectorAll<HTMLButtonElement>('[data-label-pill] button')
    ;(buttons?.[target] ?? pickerRef.current)?.focus()
  }, [store.labels])

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
          onChange={store.setLabels}
          triggerRef={pickerRef}
          className={FILTER_PICKER_CLASS}
        />
      }
      filterChips={
        store.labels.length > 0 && (
          <div ref={pillsRef} className="flex flex-wrap items-center gap-1">
            {store.labels.map((name) => (
              <Badge key={name} data-label-pill variant="secondary" title={name} onDismiss={() => dismissLabel(name)} dismissLabel={`Remove label filter ${name}`}>
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
        <NewSessionRowMenu
          key={`${issue.repositoryId}#${issue.number}`}
          item={{ kind: 'issue', repositoryId: issue.repositoryId, number: issue.number }}
        >
          <IssueRow
            issue={issue}
            selected={store.selected?.repositoryId === issue.repositoryId && store.selected.number === issue.number}
            onSelect={() => store.select({ repositoryId: issue.repositoryId, number: issue.number })}
          />
        </NewSessionRowMenu>
      ))}
    </ProjectListPane>
  )
}