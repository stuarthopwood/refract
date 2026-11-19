import type { GitChangesFileEntry, GitChangesSnapshot } from '../../../../shared/model'

export const gitEntry = (path: string, over: Partial<GitChangesFileEntry> = {}): GitChangesFileEntry => ({
  path,
  folder: '',
  mark: 'modified',
  additions: 1,
  deletions: 2,
  partial: false,
  ...over
})

export const gitGroups = (groups: Partial<GitChangesSnapshot['groups']>): GitChangesSnapshot['groups'] => ({
  conflicts: [],
  staged: [],
  changes: [],
  untracked: [],
  ...groups
})
