import type { GitChangesSnapshot } from '../../../shared/model'
import { gitGroups } from '../right-pane/git-changes/git-changes-test-fixtures'

export const gitSnapshot = (groups: Partial<GitChangesSnapshot['groups']>): GitChangesSnapshot => ({
  header: { branch: 'main', baseBranch: 'main', aheadBehind: null },
  groups: gitGroups(groups)
})
