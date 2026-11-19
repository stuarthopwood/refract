import type { GitChangesGroupKind } from '../../../../shared/model'

/** The group names the Git changes list shows. */
export const GROUP_LABELS: Record<GitChangesGroupKind, string> = {
  conflicts: 'Conflicts',
  staged: 'Staged',
  changes: 'Changes',
  untracked: 'Untracked'
}

// A file's own state, as a diff tab and the diff header show it: a tracked unstaged change reads "Unstaged", not "Changes".
const DIFF_GROUP_LABELS: Record<GitChangesGroupKind, string> = { ...GROUP_LABELS, changes: 'Unstaged' }

export function diffGroupLabel(group: GitChangesGroupKind): string {
  return DIFF_GROUP_LABELS[group]
}
