// The Manage sessions toolbar on the shared ListToolbar: four filter tabs (All / Active /
// Archived / Hidden), Project and Sort selects, the shared SearchField, and a "Showing X of Y" line while filtering.
import type { RefObject } from 'react'
import { FilterTabs } from '@/components/FilterTabs'
import { ListToolbar } from '@/components/ListToolbar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Repository } from '../../../shared/model'
import { showingCountLabel } from '@/features/sessions/sessionDisplay'
import { DEFAULT_FILTERS } from '@/state/view-store'
import type { ArchiveFilter, SessionFilters, SortKey } from '@/state/view-store'

const ARCHIVE_TABS: ReadonlyArray<{ value: ArchiveFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'hidden', label: 'Hidden' }
]

export interface ManageSessionsToolbarProps {
  filters: SessionFilters
  repositories: Repository[]
  searchInputRef: RefObject<HTMLInputElement | null>
  onFiltersChange(next: SessionFilters): void
  /** Post-build review fix (D4): the filtered-result count was previously announced only
   *  through the screen's sr-only live region (ManageSessionsScreen.tsx), invisible to a
   *  sighted user -- the header badge never updates past the unfiltered total. Shown here,
   *  beside the controls that caused the filtering, while any filter is non-default. */
  shownCount: number
  totalCount: number
}

const SORT_LABELS: Record<SortKey, string> = {
  recent: 'Recently active',
  name: 'Name, A to Z',
  repo: 'Project, A to Z',
  status: 'Status'
}

export function ManageSessionsToolbar({
  filters,
  repositories,
  searchInputRef,
  onFiltersChange,
  shownCount,
  totalCount
}: ManageSessionsToolbarProps) {
  const filtering =
    filters.search.trim() !== '' ||
    filters.repositoryId !== DEFAULT_FILTERS.repositoryId ||
    filters.archiveFilter !== DEFAULT_FILTERS.archiveFilter
  return (
    // drag-regions-allow: renders inside ManageSessionsScreen, below its own drag-region header (SettingsScreen.tsx's pattern), so it never touches App.tsx's strip despite the same shape.
    <ListToolbar
      search={{
        value: filters.search,
        onValueChange: (search) => onFiltersChange({ ...filters, search }),
        label: 'Filter sessions by name or branch',
        placeholder: 'Filter sessions…',
        inputRef: searchInputRef
      }}
      countLine={filtering ? showingCountLabel(shownCount, totalCount) : undefined}
    >
      <FilterTabs
        value={filters.archiveFilter}
        onValueChange={(archiveFilter) => onFiltersChange({ ...filters, archiveFilter })}
        tabs={ARCHIVE_TABS}
        ariaLabel="Filter sessions"
      />

      <Select value={filters.repositoryId} onValueChange={(value) => onFiltersChange({ ...filters, repositoryId: value })}>
        <SelectTrigger aria-label="Filter by project">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All projects</SelectItem>
          {repositories.map((repository) => (
            <SelectItem key={repository.id} value={repository.id}>
              {repository.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.sort} onValueChange={(value) => onFiltersChange({ ...filters, sort: value as SortKey })}>
        <SelectTrigger aria-label={`Sort sessions, ${SORT_LABELS[filters.sort]}`}>
          <span className="text-muted-foreground">Sort:</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <SelectItem key={key} value={key}>
              {SORT_LABELS[key]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ListToolbar>
  )
}
