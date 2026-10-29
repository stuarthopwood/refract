// The Issues list column (issue #504, spec 051): the shared Filter tabs, Filters toggle and
// Refresh button over a collapsible panel (search, State, Project, Label), a closed-by-default
// "N projects skipped" disclosure, a polite results summary, and the rows. Same shape as the
// Pull requests list (`PullRequestList.tsx`); the pieces are the shared components.
import { useEffect, useRef, useState } from 'react'
import { ChevronRightIcon, FunnelIcon, SearchXIcon } from 'lucide-react'
import { FilterTabs } from '@/components/FilterTabs'
import { MultiSelectChecklist } from '@/components/MultiSelectChecklist'
import { SearchField } from '@/components/SearchField'
import { ColourDot } from '@/components/ColourDot'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { RefreshButton } from '@/features/pull-requests/RefreshButton'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { cn } from '@/lib/utils'
import { useIssuesStore, useRepositoriesStore } from '@/state'
import type { IssueStateFilter, IssueTab } from '../../../shared/ipc-issues'
import { IssueRow } from './IssueRow'
import { useIssueLabelOptions } from './useIssueLabelOptions'

const TABS: Array<{ value: IssueTab; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'authored', label: 'Authored by me' },
  { value: 'mentions', label: 'Mentions me' }
]

const STATE_OPTIONS: Array<{ value: IssueStateFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'Any state' }
]

// Radix Select forbids an empty-string item value, so "any label" gets a sentinel.
const ANY_LABEL = '__any__'

const ERROR_MESSAGES: Record<string, string> = {
  'no-github-remote': 'This project has no GitHub remote.',
  'gh-unavailable': 'GitHub is not available: sign in with the GitHub CLI (gh auth login), or check your connection.',
  'rate-limited': 'GitHub rate limit reached. Try again in a few minutes.'
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function IssueList() {
  const repositories = useRepositoriesStore((s) => s.repositories)
  const store = useIssuesStore()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [skippedOpen, setSkippedOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filtersButtonRef = useRef<HTMLButtonElement>(null)

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

  const activeFilterCount =
    (store.appliedQuery.trim() !== '' ? 1 : 0) +
    (store.state !== 'open' ? 1 : 0) +
    (store.repositoryIds.length > 0 ? 1 : 0) +
    (store.label !== null ? 1 : 0)
  const filtersLabel = activeFilterCount > 0 ? `Filters, ${activeFilterCount} active` : 'Filters'

  // The whole list is replaced by an error only when every skipped Project is down for gh-wide reasons.
  const ghWideCode = ['gh-unavailable', 'rate-limited'].find((code) =>
    store.skipped.every((project) => project.code === code)
  )
  const friendlyError = store.error
    ? (ERROR_MESSAGES[store.error.code] ?? store.error.message)
    : store.items.length === 0 && store.skipped.length > 0 && ghWideCode
      ? ERROR_MESSAGES[ghWideCode]
      : null

  const projectSummary =
    store.repositoryIds.length === 0 ? 'All projects' : `${store.repositoryIds.length} of ${allIds.length} projects`
  const projectCount = new Set(store.items.map((issue) => issue.repositoryId)).size
  const resultsSummary = store.loading
    ? 'Loading…'
    : store.fetchedAt
      ? `${plural(store.items.length, 'issue')} across ${plural(projectCount, 'project')}`
      : ''

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-2">
      <div className="flex items-center gap-1">
        <FilterTabs value={store.tab} onValueChange={store.setTab} tabs={TABS} />
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild aria-describedby={undefined}>
              <Button
                ref={filtersButtonRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={filtersLabel}
                aria-expanded={filtersOpen}
                aria-controls={filtersOpen ? 'issue-filters-panel' : undefined}
                onClick={() => setFiltersOpen((open) => !open)}
                className={cn('relative aria-expanded:bg-muted aria-expanded:text-foreground', COMPOSER_BUTTON_FOCUS_CLASS)}
              >
                <FunnelIcon aria-hidden className="size-4" />
                {activeFilterCount > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{filtersLabel}</TooltipContent>
          </Tooltip>
          <RefreshButton loading={store.loading} onClick={() => void refresh(allIds)} label="Refresh issues" />
        </div>
      </div>
      {filtersOpen && (
        <div id="issue-filters-panel" className="flex flex-col gap-2">
          <SearchField
            value={store.query}
            onValueChange={(value) => {
              store.setQuery(value)
              // Emptying a search that was applied refetches at once, as in the Pull requests view.
              if (value === '' && store.appliedQuery !== '') void refresh(allIds)
            }}
            onSubmit={() => void refresh(allIds)}
            label="Search issues"
            placeholder="Search issues"
            className="h-8"
            inputRef={searchInputRef}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={store.state} onValueChange={(value) => store.setState(value as IssueStateFilter)}>
              <SelectTrigger aria-label="State" className="w-28 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {STATE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <MultiSelectChecklist
              label="Project"
              summary={projectSummary}
              options={repositories.map((repo) => ({ value: repo.id, label: repo.name }))}
              selected={store.repositoryIds}
              onChange={store.setRepositoryIds}
              className="min-w-0 max-w-44 flex-1"
            />
            <Select
              value={store.label ?? ANY_LABEL}
              onValueChange={(value) => store.setLabel(value === ANY_LABEL ? null : value)}
            >
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
          </div>
        </div>
      )}
      <div className="text-xs text-muted-foreground" role="status" aria-live="polite">
        {resultsSummary}
        {store.fetchedAt && !store.loading ? ` · Last updated ${formatRelativeTime(store.fetchedAt)}` : ''}
      </div>
      {store.skipped.length > 0 && !friendlyError && (
        <div className="text-xs text-muted-foreground">
          <button
            type="button"
            aria-expanded={skippedOpen}
            onClick={() => setSkippedOpen((open) => !open)}
            className="flex items-center gap-1 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRightIcon aria-hidden className={cn('size-3.5 transition-transform', skippedOpen && 'rotate-90')} />
            {plural(store.skipped.length, 'project')} skipped
          </button>
          {skippedOpen && (
            <ul className="mt-1 flex flex-col gap-1 pl-5">
              {store.skipped.map((project) => (
                <li key={project.repositoryId}>
                  {project.repositoryName}: {ERROR_MESSAGES[project.code] ?? project.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {friendlyError ? (
          <div role="alert" className="p-4 text-sm text-destructive">
            {friendlyError}
          </div>
        ) : store.items.length === 0 && !store.loading ? (
          activeFilterCount > 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No issues match these filters.</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="outline"
                  onClick={() => {
                    // The fetch effect refetches once the filters reset.
                    store.clearFilters()
                    requestAnimationFrame(() => (filtersOpen ? searchInputRef : filtersButtonRef).current?.focus())
                  }}
                >
                  Clear filters
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">No issues match this tab.</div>
          )
        ) : (
          <div className="flex flex-col divide-y divide-divider">
            {store.items.map((issue) => (
              <IssueRow
                key={`${issue.repositoryId}#${issue.number}`}
                issue={issue}
                selected={store.selected?.repositoryId === issue.repositoryId && store.selected.number === issue.number}
                onSelect={() => store.select({ repositoryId: issue.repositoryId, number: issue.number })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
