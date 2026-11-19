import { frontActiveTab, useRightPaneStore } from '@/state/right-pane-store'
import type { GitChangesGroupKind } from '../../../../shared/model'
import { createOriginTracker } from '../focus-return-tracker'
import { focusGitRow, focusGitRowInGroup, focusNearestGroupTrigger } from './focus'

const originKey = (sessionId: string, tabId: string): string => `${sessionId}\n${tabId}`

export function encodeOrigin(group: GitChangesGroupKind, path: string): string {
  return `${group}\n${path}`
}

export function decodeOrigin(value: string): { group: GitChangesGroupKind; path: string } {
  const split = value.indexOf('\n')
  return { group: value.slice(0, split) as GitChangesGroupKind, path: value.slice(split + 1) }
}

/** A retarget renames the tab; carrying the origin over (into the row's new group) keeps the rename from reading as a close. */
export function moveOrigin(map: Map<string, string>, sessionId: string, fromId: string, toId: string, group: GitChangesGroupKind): void {
  const value = map.get(originKey(sessionId, fromId))
  if (value === undefined) return
  map.delete(originKey(sessionId, fromId))
  if (!map.has(originKey(sessionId, toId))) map.set(originKey(sessionId, toId), encodeOrigin(group, decodeOrigin(value).path))
}

function gitPanelShowing(): boolean {
  const tab = frontActiveTab()
  return useRightPaneStore.getState().open && tab?.kind === 'panel' && tab.id === 'git-changes'
}

const tracker = createOriginTracker({
  isShowing: gitPanelShowing,
  // The row in its own group first; the same file in another group if a retarget moved it.
  focusTarget(sessionId, value) {
    const { group, path } = decodeOrigin(value)
    return focusGitRowInGroup(sessionId, group, path) || focusGitRow(sessionId, path)
  },
  focusFallback(sessionId, value) {
    focusNearestGroupTrigger(sessionId, decodeOrigin(value).group)
  }
})

/** Remembers which Git changes row opened a diff tab, so closing it can send focus back (FR-006). */
export function rememberDiffOrigin(sessionId: string, tabId: string, group: GitChangesGroupKind, path: string): void {
  tracker.remember(sessionId, tabId, encodeOrigin(group, path))
}

export function moveDiffOrigin(sessionId: string, fromId: string, toId: string, group: GitChangesGroupKind): void {
  moveOrigin(tracker.origins, sessionId, fromId, toId, group)
}

/** Forgets every origin and the store subscription; for tests. */
export const resetDiffOrigins = tracker.reset
