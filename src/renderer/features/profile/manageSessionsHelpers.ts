// Pure helpers for the Manage sessions screen (spec 008 FR-025, T026): filtering, sorting, and
// the count/summary wording, kept tiny and exported as plain functions for a future test
// (matching this spec's own small-renderer-helper convention, e.g.
// src/renderer/lib/account-format.ts).
import type { SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import type { SessionFilters } from '@/state/view-store'
import { displayStatus, matchesNameOrBranch } from '@/features/sessions/sessionDisplay'
import type { SessionDisplayStatus } from '@/features/sessions/sessionDisplay'

// Issue #731 decision 8: Manage sessions' own Status sort order -- needs-you, Unread response,
// working, idle, stopped -- the same order #735's planned collapsed-group top-state badge will
// use. This is a sort order, not the display precedence `displayStatus` itself encodes
// (CONTEXT.md's Session status entry: Working, Needs you, Stopped, Unread response, Idle).
const STATUS_ORDER: Record<SessionDisplayStatus, number> = {
  'needs-you': 0,
  'unread-response': 1,
  working: 2,
  idle: 3,
  stopped: 4
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
    if (filters.archiveFilter === 'hidden' && !session.hiddenAt) return false
    if (!matchesNameOrBranch(session, query)) return false
    return true
  })
  return [...filtered].sort((a, b) => {
    switch (filters.sort) {
      case 'name':
        return a.name.localeCompare(b.name)
      case 'repo':
        return (repoNameById.get(a.repositoryId) ?? '').localeCompare(repoNameById.get(b.repositoryId) ?? '')
      case 'status':
        return STATUS_ORDER[displayStatus(a)] - STATUS_ORDER[displayStatus(b)]
      case 'recent':
      default:
        return b.lastActivityAt.localeCompare(a.lastActivityAt)
    }
  })
}

/** The header's own count line: "N sessions across M projects", singular for N=1/M=1. */
export function sessionCountLabel(sessionCount: number, repositoryCount: number): string {
  const sessionWord = sessionCount === 1 ? 'session' : 'sessions'
  const repoWord = repositoryCount === 1 ? 'project' : 'projects'
  return `${sessionCount} ${sessionWord} across ${repositoryCount} ${repoWord}`
}

/** Post-build review fix (Phase7PostBuild, Low): the header's own count line counts
 *  repositories a session actually EXISTS in, never every registered Repository (several of
 *  which may have zero sessions at all) -- distinct `session.repositoryId` values only. */
export function distinctRepositoryCount(sessions: SessionSummary[]): number {
  return new Set(sessions.map((session) => session.repositoryId)).size
}

