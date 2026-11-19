import type { GitChangesSnapshot } from '../../../shared/model'
import { entrySignature, findLiveEntry } from '../right-pane/git-changes/git-diff-state'
import { GROUP_ORDER } from '../right-pane/git-changes/focus'

/**
 * Changes whenever the Session's git snapshot says this file changed, so an open file tab reloads. Empty for a file in no group,
 * so the snapshot arriving for an untouched file does not trigger a second read.
 */
export function fileChangeSignature(snapshot: GitChangesSnapshot | null | undefined, path: string): string {
  return GROUP_ORDER.map((group) => {
    const entry = findLiveEntry(snapshot, group, path)
    return entry ? `${group}:${entrySignature(entry)}` : ''
  }).join('|')
}
