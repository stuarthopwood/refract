// Pure helpers for the Manage sessions screen (spec 008 FR-025, T026): filtering, sorting, and
// the count/summary wording, kept tiny and exported as plain functions for a future test
// (matching this spec's own small-renderer-helper convention, e.g.
// src/renderer/lib/account-format.ts).
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'

export type ArchiveFilter = 'all' | 'active' | 'archived'
export type SortKey = 'recent' | 'name' | 'repo' | 'status'

const STATUS_ORDER: Record<SessionSummary['status'], number> = {
  'needs-you': 0,
  working: 1,
  idle: 2,
  stopped: 3
}

export interface SessionFilters {
  search: string
  repositoryId: string // 'all' or a real Repository id
  archiveFilter: ArchiveFilter
  sort: SortKey
}

export const DEFAULT_FILTERS: SessionFilters = {
  search: '',
  repositoryId: 'all',
  archiveFilter: 'all',
  sort: 'recent'
}

/** Filters, then sorts, `sessions` per `filters` -- never mutates the input array. Search matches
 *  the session's name OR branch, case-insensitive substring (FR-025's own "filters name and
 *  branch" requirement). */
export function filterAndSortSessions(
  sessions: SessionSummary[],
  repositories: Repository[],
  filters: SessionFilters
): SessionSummary[] {
  const repoNameById = new Map(repositories.map((repository) => [repository.id, repository.name]))
  const query = filters.search.trim().toLowerCase()
  const filtered = sessions.filter((session) => {
    if (filters.repositoryId !== 'all' && session.repositoryId !== filters.repositoryId) return false
    if (filters.archiveFilter === 'active' && session.archivedAt) return false
    if (filters.archiveFilter === 'archived' && !session.archivedAt) return false
    if (query && !session.name.toLowerCase().includes(query) && !session.branch.toLowerCase().includes(query)) return false
    return true
  })
  return [...filtered].sort((a, b) => {
    switch (filters.sort) {
      case 'name':
        return a.name.localeCompare(b.name)
      case 'repo':
        return (repoNameById.get(a.repositoryId) ?? '').localeCompare(repoNameById.get(b.repositoryId) ?? '')
      case 'status':
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      case 'recent':
      default:
        return b.lastActivityAt.localeCompare(a.lastActivityAt)
    }
  })
}

/** The header's own count line: "N sessions across M repositories", singular for N=1/M=1. */
export function sessionCountLabel(sessionCount: number, repositoryCount: number): string {
  const sessionWord = sessionCount === 1 ? 'session' : 'sessions'
  const repoWord = repositoryCount === 1 ? 'repository' : 'repositories'
  return `${sessionCount} ${sessionWord} across ${repositoryCount} ${repoWord}`
}

/** Post-build review fix (Phase7PostBuild, Low): the header's own count line counts
 *  repositories a session actually EXISTS in, never every registered Repository (several of
 *  which may have zero sessions at all) -- distinct `session.repositoryId` values only. */
export function distinctRepositoryCount(sessions: SessionSummary[]): number {
  return new Set(sessions.map((session) => session.repositoryId)).size
}

/** The filtered-result announcement: "Showing X of N sessions", singular "session" when the
 *  UNFILTERED total itself is 1 (the thing actually being enumerated). */
export function showingCountLabel(shown: number, total: number): string {
  return `Showing ${shown} of ${total} ${total === 1 ? 'session' : 'sessions'}`
}
