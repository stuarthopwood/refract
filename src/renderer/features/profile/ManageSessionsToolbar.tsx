// The Manage sessions screen's toolbar (spec 008 FR-025, T026; rebuilt on the shared ListToolbar
// for #934): Filter tabs (All / Active / Archived), a Project select, a Sort select, the shared
// SearchField, and a plain muted "Showing X of Y" line while filtering.
import type { RefObject } from 'react'
import { ListToolbar } from '@/components/ListToolbar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Repository } from '../../../shared/model'
import { showingCountLabel } from '@/features/sessions/sessionDisplay'
import type { ArchiveFilter, SessionFilters, SortKey } from '@/state/view-store'

export interface ManageSessionsToolbarProps {
  filters: SessionFilters
  repositories: Repository[]
  searchInputRef: RefObject<HTMLInputElement | null>
  onFiltersChange(next: SessionFilters): void
  /** Post-build review fix (D4): the filtered-result count was previously announced only
   *  through the screen's sr-only live region (ManageSessionsScreen.tsx), invisible to a
   *  sighted user -- the header badge never updates past the unfiltered total. Shown here,
   *  beside the controls that caused the filtering, only while `shownCount` differs from
   *  `totalCount` (which is never true with nothing filtered, since filtering alone changes
   *  which sessions are included). */
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
      countLine={shownCount !== totalCount ? showingCountLabel(shownCount, totalCount) : undefined}
    >
      <Tabs
        value={filters.archiveFilter}
        onValueChange={(value) => onFiltersChange({ ...filters, archiveFilter: value as ArchiveFilter })}
        className="gap-0"
      >
        <TabsList aria-label="Filter by archive status">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList>
      </Tabs>

      <Select value={filters.repositoryId} onValueChange={(value) => onFiltersChange({ ...filters, repositoryId: value })}>
        <SelectTrigger aria-label="Filter by project" className="w-48">
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
        <SelectTrigger aria-label="Sort sessions" className="w-44">
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