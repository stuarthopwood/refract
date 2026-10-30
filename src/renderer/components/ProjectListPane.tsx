// The shared list pane for the cross-Project Issues and Pull requests views (issues #504, #874;
// spec 057; ADR 0003): Filter tabs, the one Filters toggle and Refresh over a collapsible panel
// (search, State, Project, plus an `extraFilters` slot), a polite results summary, a closed-by-
// default "N projects skipped" disclosure, the error alert, the one empty state with "Clear
// filters", optional "Show more", and the rows as `children`.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRightIcon, FunnelIcon, SearchXIcon } from 'lucide-react'
import { FilterTabs } from '@/components/FilterTabs'
import { MultiSelectChecklist } from '@/components/MultiSelectChecklist'
import { SearchField } from '@/components/SearchField'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { RefreshButton } from '@/features/pull-requests/RefreshButton'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'
import { cn } from '@/lib/utils'
import type { IpcError } from '../../shared/ipc'
import type { IssueSkippedProject } from '../../shared/ipc-issues'

export type ListStateFilter = 'open' | 'closed' | 'all'

const STATE_OPTIONS: Array<{ value: ListStateFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'Any state' }
]

const ERROR_MESSAGES: Record<string, string> = {
  'no-github-remote': 'This project has no GitHub remote.',
  'gh-unavailable': 'GitHub is not available: sign in with the GitHub CLI (gh auth login), or check your connection.',
  'rate-limited': 'GitHub rate limit reached. Try again in a few minutes.'
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export interface ProjectListPaneProps<Tab extends string> {
  /** Singular and plural nouns for the copy, e.g. `issue` and `issues`. */
  noun: { singular: string; plural: string }
  idPrefix: string
  tabs: Array<{ value: Tab; label: string }>
  tab: Tab
  onTabChange(tab: Tab): void
  state: ListStateFilter
  onStateChange(state: ListStateFilter): void
  projects: Array<{ id: string; name: string }>
  /** Chosen Project ids; empty means every Project. */
  repositoryIds: string[]
  onRepositoryIdsChange(ids: string[]): void
  query: string
  appliedQuery: string
  onQueryChange(query: string): void
  /** Fetches again; called on Enter in the search, on Refresh and when an applied search is emptied. */
  onRefresh(): void
  onClearFilters(): void
  /** Filters this view adds beside State and Project (for example Issues' Label), and how many are set. */
  extraFilters?: ReactNode
  extraActiveCount?: number
  loading: boolean
  fetchedAt: string | null
  error: IpcError | null
  skipped: IssueSkippedProject[]
  itemCount: number
  projectCount: number
  /** Shows "Show more" while `hasMore`, and the cap note once `atCap`. */
  paging?: { hasMore: boolean; atCap: boolean; cap: number; onLoadMore(): void }
  children: ReactNode
}

export function ProjectListPane<Tab extends string>(props: ProjectListPaneProps<Tab>) {
  const { noun, idPrefix, state, repositoryIds, projects, skipped, error, itemCount, loading, paging } = props
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [skippedOpen, setSkippedOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filtersButtonRef = useRef<HTMLButtonElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const capNoteRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const askedForMore = useRef(false)

  const showCapNote = Boolean(paging?.atCap) && !loading
  // "Show more" keeps its focus while loading (aria-disabled). When the button then vanishes
  // (cap reached or list exhausted), move focus to the footer note or the list so it is not lost.
  useEffect(() => {
    if (loading || !askedForMore.current) return
    if (paging?.hasMore) return
    askedForMore.current = false
    ;(capNoteRef.current ?? listRef.current)?.focus()
  }, [loading, paging?.hasMore, showCapNote])

  const activeFilterCount =
    (props.appliedQuery.trim() !== '' ? 1 : 0) +
    (state !== 'open' ? 1 : 0) +
    (repositoryIds.length > 0 ? 1 : 0) +
    (props.extraActiveCount ?? 0)
  const filtersLabel = activeFilterCount > 0 ? `Filters, ${activeFilterCount} active` : 'Filters'
  const panelId = `${idPrefix}-filters-panel`

  // The whole list is replaced by an error only when every skipped Project is down for gh-wide reasons.
  const ghWideCode = ['gh-unavailable', 'rate-limited'].find((code) => skipped.every((project) => project.code === code))
  const friendlyError = error
    ? (ERROR_MESSAGES[error.code] ?? error.message)
    : itemCount === 0 && skipped.length > 0 && ghWideCode
      ? ERROR_MESSAGES[ghWideCode]
      : null

  const projectSummary =
    repositoryIds.length === 0 ? 'All projects' : `${repositoryIds.length} of ${projects.length} projects`
  const resultsSummary = loading
    ? 'Loading…'
    : props.fetchedAt
      ? `${plural(itemCount, noun.singular)} across ${plural(props.projectCount, 'project')}`
      : ''

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-2">
      <div className="flex items-center gap-1">
        <FilterTabs value={props.tab} onValueChange={props.onTabChange} tabs={props.tabs} />
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
                aria-controls={filtersOpen ? panelId : undefined}
                onClick={() => setFiltersOpen((open) => !open)}
                className={cn('relative aria-expanded:bg-muted aria-expanded:text-foreground', COMPOSER_BUTTON_FOCUS_CLASS)}
              >
                <FunnelIcon aria-hidden className="size-4" />
                {activeFilterCount > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{filtersLabel}</TooltipContent>
          </Tooltip>
          <RefreshButton loading={loading} onClick={props.onRefresh} label={`Refresh ${noun.plural}`} />
        </div>
      </div>
      {filtersOpen && (
        <div id={panelId} className="flex flex-col gap-2">
          <SearchField
            value={props.query}
            onValueChange={(value) => {
              props.onQueryChange(value)
              // Emptying a search that was applied refetches at once.
              if (value === '' && props.appliedQuery !== '') props.onRefresh()
            }}
            onSubmit={props.onRefresh}
            label={`Search ${noun.plural}`}
            placeholder={`Search ${noun.plural}`}
            className="h-8"
            inputRef={searchInputRef}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={state} onValueChange={(value) => props.onStateChange(value as ListStateFilter)}>
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
              options={projects.map((project) => ({ value: project.id, label: project.name }))}
              selected={repositoryIds}
              onChange={props.onRepositoryIdsChange}
              className="min-w-0 max-w-44 flex-1"
            />
            {props.extraFilters}
          </div>
        </div>
      )}
      <div className="text-xs text-muted-foreground" role="status" aria-live="polite">
        {resultsSummary}
        {props.fetchedAt && !loading ? ` · Last updated ${formatRelativeTime(props.fetchedAt)}` : ''}
      </div>
      {skipped.length > 0 && !friendlyError && (
        <div className="text-xs text-muted-foreground">
          <button
            type="button"
            aria-expanded={skippedOpen}
            onClick={() => setSkippedOpen((open) => !open)}
            className="flex items-center gap-1 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRightIcon aria-hidden className={cn('size-3.5 transition-transform', skippedOpen && 'rotate-90')} />
            {plural(skipped.length, 'project')} skipped
          </button>
          {skippedOpen && (
            <ul className="mt-1 flex flex-col gap-1 pl-4">
              {skipped.map((project) => (
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
        ) : itemCount === 0 && !loading ? (
          activeFilterCount > 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>No {noun.plural} match these filters.</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="outline"
                  onClick={() => {
                    // The view's fetch effect refetches once the filters reset.
                    props.onClearFilters()
                    requestAnimationFrame(() => (filtersOpen ? searchInputRef : filtersButtonRef).current?.focus())
                  }}
                >
                  Clear filters
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">No {noun.plural} match this tab.</div>
          )
        ) : (
          <>
            <div ref={listRef} tabIndex={-1} className="flex flex-col divide-y divide-divider outline-none">
              {props.children}
            </div>
            {paging?.hasMore && (
              <div className="flex justify-center p-2">
                <Button
                  ref={moreRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={loading}
                  onClick={() => {
                    if (loading) return
                    askedForMore.current = true
                    paging.onLoadMore()
                  }}
                >
                  Show more {noun.plural}
                </Button>
              </div>
            )}
            {showCapNote && (
              <div
                ref={capNoteRef}
                tabIndex={-1}
                className="p-2 text-center text-xs text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
              >
                Showing the first {paging?.cap}, narrow with filters.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
