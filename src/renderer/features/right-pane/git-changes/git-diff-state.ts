import type { Result } from '../../../../shared/ipc'
import type { GitChangesFileEntry, GitChangesGroupKind, GitChangesSnapshot } from '../../../../shared/model'

export type DiffState = 'loading' | { patch: string; reason?: string | null } | { error: string }

export const NO_LONGER_CHANGED = 'No longer changed'
export const DIFF_LOAD_ERROR = "Couldn't load this file's diff"

export function findLiveEntry(snapshot: GitChangesSnapshot | null | undefined, group: GitChangesGroupKind, path: string): GitChangesFileEntry | null {
  return snapshot?.groups[group].find((entry) => entry.path === path) ?? null
}

/** Only a loaded snapshot can say a file left its group; before that, absence means "not known yet". */
export function isNoLongerChanged(snapshot: GitChangesSnapshot | null | undefined, group: GitChangesGroupKind, path: string): boolean {
  return snapshot != null && findLiveEntry(snapshot, group, path) === null
}

/** A change to any of these means the file's diff moved on, so it is fetched again. */
export function entrySignature(entry: GitChangesFileEntry | null): string {
  return entry ? `${entry.mark}:${entry.additions}:${entry.deletions}:${entry.partial}` : 'unknown'
}

export function noLongerChangedAnnouncement(path: string): string {
  return `${NO_LONGER_CHANGED}: ${path.split('/').pop()}`
}

/** Keeps the previous object for an identical patch, so a refresh that changed nothing does not re-render the diff. */
export function nextDiffState(prev: DiffState, result: Result<{ patch: string; reason: string | null }>): DiffState {
  if (!result.ok) return { error: result.error.message }
  const { patch, reason } = result.value
  return typeof prev === 'object' && 'patch' in prev && prev.patch === patch && prev.reason === reason ? prev : { patch, reason }
}

/** Counts for a diff opened before the Session's snapshot has loaded; the patch body holds hunks only, so no header lines to skip. */
export function patchStats(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}
