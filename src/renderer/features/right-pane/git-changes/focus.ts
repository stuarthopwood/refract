import type { GitChangesGroupKind } from '../../../../shared/model'

// Neutral leaf module: defining this in the panel/group/row files would make their imports circular.
export const GROUP_ORDER: readonly GitChangesGroupKind[] = ['conflicts', 'staged', 'changes', 'untracked']

// Scoped by session so a Split's other pane showing the same path can't match.
function gitChangesRoot(sessionId: string): ParentNode | null {
  return document.querySelector(`[data-git-changes-session="${CSS.escape(sessionId)}"]`)
}

/** Focuses the row for `path` in this Session's panel in any group; returns whether it was found. */
export function focusGitRow(sessionId: string, path: string): boolean {
  const el = gitChangesRoot(sessionId)?.querySelector<HTMLElement>(`[data-git-row-path="${CSS.escape(path)}"]`)
  if (!el) return false
  el.focus()
  return true
}

/** Focuses the row for `path` within `group` only; a partially staged file renders in two groups, so the unscoped lookup would pick the wrong half. */
export function focusGitRowInGroup(sessionId: string, group: GitChangesGroupKind, path: string): boolean {
  const el = gitChangesRoot(sessionId)?.querySelector<HTMLElement>(
    `[data-git-group-list="${CSS.escape(group)}"] [data-git-row-path="${CSS.escape(path)}"]`
  )
  if (!el) return false
  el.focus()
  return true
}

/** Focuses `kind`'s group trigger if that group is rendered; returns whether it was found. */
export function focusGitGroupTrigger(sessionId: string, kind: GitChangesGroupKind): boolean {
  const el = gitChangesRoot(sessionId)?.querySelector<HTMLElement>(`[data-git-group-trigger="${kind}"]`)
  if (!el) return false
  el.focus()
  return true
}

/** Focuses the first rendered group trigger after `afterKind` in `GROUP_ORDER`, wrapping around. */
export function focusNearestGroupTrigger(sessionId: string, afterKind: GitChangesGroupKind): void {
  const startIndex = GROUP_ORDER.indexOf(afterKind)
  const ordered = startIndex < 0 ? GROUP_ORDER : [...GROUP_ORDER.slice(startIndex + 1), ...GROUP_ORDER.slice(0, startIndex + 1)]
  for (const kind of ordered) {
    if (focusGitGroupTrigger(sessionId, kind)) return
  }
}
