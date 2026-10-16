// The Manage sessions screen's toolbar (spec 008 FR-025, T026): a search Input (name/branch),
// a repository Select, an archive-state ToggleGroup, and a sort Select -- the minimum genuinely
// useful set, all built from existing primitives.
import type { KeyboardEvent, RefObject } from 'react'
import { SearchIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
  repo: 'Repository, A to Z',
  status: 'Status'
}

// Post-build review fix (Phase7PostBuild, Medium): every selected segment of this ToggleGroup
// shares the one `--active-indicator` treatment DESIGN.md's own "Active/selected indicator" rule
// requires for every current/selected surface in the app (a 2px left-edge bar), overriding
// toggle.tsx's own default `data-[state=on]:bg-primary` fill -- the brightest thing on the
// screen otherwise, and the only control in the renderer using that fill for a filter state.
const SELECTED_SEGMENT_CLASS =
  'data-[state=on]:bg-muted data-[state=on]:text-foreground data-[state=on]:hover:bg-muted data-[state=on]:shadow-[inset_2px_0_0_0_var(--color-active-indicator)]'

export function ManageSessionsToolbar({
  filters,
  repositories,
  searchInputRef,
  onFiltersChange,
  shownCount,
  totalCount
}: ManageSessionsToolbarProps) {
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape' && filters.search) {
      event.preventDefault()
      onFiltersChange({ ...filters, search: '' })
    }
  }

  return (
    // drag-regions-allow: renders inside ManageSessionsScreen, below its own drag-region header (SettingsScreen.tsx's pattern), so it never touches App.tsx's strip despite the same shape.
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border p-3">
      <div className="relative w-64">
        <SearchIcon aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchInputRef}
          value={filters.search}
          onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
          onKeyDown={handleSearchKeyDown}
          placeholder="Filter sessions…"
          aria-label="Filter sessions by name or branch"
          className="pl-7"
        />
      </div>

      <Select value={filters.repositoryId} onValueChange={(value) => onFiltersChange({ ...filters, repositoryId: value })}>
        <SelectTrigger aria-label="Filter by repository" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All repositories</SelectItem>
          {repositories.map((repository) => (
            <SelectItem key={repository.id} value={repository.id}>
              {repository.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ToggleGroup
        type="single"
        value={filters.archiveFilter}
        onValueChange={(value) => {
          // Radix emits '' when the already-selected item is clicked again (deselecting it);
          // this group always keeps exactly one of the three selected.
          if (value) onFiltersChange({ ...filters, archiveFilter: value as ArchiveFilter })
        }}
        variant="outline"
        spacing={0}
        aria-label="Filter by archive status"
      >
        <ToggleGroupItem value="all" className={SELECTED_SEGMENT_CLASS}>
          All
        </ToggleGroupItem>
        <ToggleGroupItem value="active" className={SELECTED_SEGMENT_CLASS}>
          Active
        </ToggleGroupItem>
        <ToggleGroupItem value="archived" className={SELECTED_SEGMENT_CLASS}>
          Archived
        </ToggleGroupItem>
      </ToggleGroup>

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

      {shownCount !== totalCount && (
        <span className="shrink-0 text-xs text-muted-foreground">{showingCountLabel(shownCount, totalCount)}</span>
      )}
    </div>
  )
}
