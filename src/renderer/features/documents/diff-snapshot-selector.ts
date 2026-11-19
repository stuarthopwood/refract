import type { GitChangesSnapshot } from '../../../shared/model'

type SnapshotsBySession = Record<string, { snapshot: GitChangesSnapshot | null } | undefined>

/** Null unless a diff tab needs it, so a Session without one does not re-render the shell on every git watch event. */
export function snapshotForDiffTabs(bySession: SnapshotsBySession, sessionId: string | null, hasDiffTab: boolean): GitChangesSnapshot | null {
  if (!hasDiffTab || !sessionId) return null
  return bySession[sessionId]?.snapshot ?? null
}
