import type { DocumentTab } from '@/state/document-tabs-store'
import type { GitChangesGroupKind, GitChangesSnapshot } from '../../../../shared/model'
import { GROUP_ORDER } from './focus'

export interface DiffRetarget {
  id: string
  group: GitChangesGroupKind
  to: GitChangesGroupKind
  path: string
}

/**
 * Staging or unstaging a file moves it to another group. A diff tab follows once its own group no longer holds the file but another does;
 * a file gone from every group (committed, reverted) is left to the view's "No longer changed" state.
 */
export function planDiffRetargets(tabs: readonly DocumentTab[], groups: GitChangesSnapshot['groups']): DiffRetarget[] {
  const holds = (group: GitChangesGroupKind, path: string) => groups[group].some((entry) => entry.path === path)
  const plan: DiffRetarget[] = []
  for (const tab of tabs) {
    if (tab.kind !== 'diff' || holds(tab.group, tab.path)) continue
    const to = GROUP_ORDER.find((group) => holds(group, tab.path))
    if (to) plan.push({ id: tab.id, group: tab.group, to, path: tab.path })
  }
  return plan
}
