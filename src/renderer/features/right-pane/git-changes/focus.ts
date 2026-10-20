// Spec 018 slice 1 (issue #464), gate round 1 (item 7): shared focus-restoration helpers for
// the Git changes panel. Every query is scoped to THIS Session's own panel instance via
// `data-git-changes-session` (set on `GitChangesPanel.tsx`'s own root element) -- a plain
// `document.querySelector` would also match a Split's OTHER pane if it happened to show the
// same path/group kind, or (FR-022) the same Session rendered in both panes at once.
import type { GitChangesGroupKind } from '../../../../shared/model'

// FR-002's own order: Conflicts/Staged/Changes/Untracked. Owned in this neutral leaf module
// (imported by `GitChangesGroup.tsx`, `GitChangesFileRow.tsx`, and `GitChangesPanel.tsx` alike)
// rather than any one of those three, since `GitChangesPanel.tsx` imports `GitChangesGroup.tsx`
// which imports `GitChangesFileRow.tsx` -- defining it in either of the latter two would make
// the other's own import of it circular.
export const GROUP_ORDER: readonly GitChangesGroupKind[] = ['conflicts', 'staged', 'changes', 'untracked']

function gitChangesRoot(sessionId: string): ParentNode | null {
  return document.querySelector(`[data-git-changes-session="${CSS.escape(sessionId)}"]`)
}

/** Focuses the row for `path` within this Session's own panel, if it is currently rendered
 * (its group may have changed, but `data-git-row-path` is set on every group's own rows the
 * same way). Returns whether a row was found and focused. */
export function focusGitRow(sessionId: string, path: string): boolean {
  const el = gitChangesRoot(sessionId)?.querySelector<HTMLElement>(`[data-git-row-path="${CSS.escape(path)}"]`)
  if (!el) return false
  el.focus()
  return true
}

/** Focuses `kind`'s own group trigger within this Session's own panel, if that group currently
 * renders at all (an empty group is not rendered, so its trigger does not exist). Returns
 * whether a trigger was found and focused. */
export function focusGitGroupTrigger(sessionId: string, kind: GitChangesGroupKind): boolean {
  const el = gitChangesRoot(sessionId)?.querySelector<HTMLElement>(`[data-git-group-trigger="${kind}"]`)
  if (!el) return false
  el.focus()
  return true
}

/** Item 7's "the nearest surviving row or group trigger" fallback: walks `GROUP_ORDER` starting
 * right AFTER `afterKind` (wrapping back around to the start, `afterKind` itself last), and
 * focuses the first group trigger found still rendered. Used both as the Stage-all/Unstage-all
 * "focus the next group's trigger" rule, and as a single-row stage/unstage's own fallback when
 * the moved row itself can no longer be found anywhere (its new group collapsed to empty, the
 * rarer case -- `focusGitRow` is tried first by every caller). */
export function focusNearestGroupTrigger(sessionId: string, afterKind: GitChangesGroupKind): void {
  const startIndex = GROUP_ORDER.indexOf(afterKind)
  const ordered = startIndex < 0 ? GROUP_ORDER : [...GROUP_ORDER.slice(startIndex + 1), ...GROUP_ORDER.slice(0, startIndex + 1)]
  for (const kind of ordered) {
    if (focusGitGroupTrigger(sessionId, kind)) return
  }
}
