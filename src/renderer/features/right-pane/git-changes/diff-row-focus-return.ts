import { useDocumentTabsStore } from '@/state/document-tabs-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { shouldReturnFocusToRow, takeClosedOrigins } from '../file-explorer/row-focus-return'
import type { GitChangesGroupKind } from '../../../../shared/model'
import { focusGitRow, focusGitRowInGroup, focusNearestGroupTrigger } from './focus'

// The panel is unmounted while a diff tab is active, so the originating row is tracked here, not in the panel.
const origins = new Map<string, string>()
let watching = false

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

function focusLocation(): 'body' | 'tab-strip' | 'other' {
  const active = document.activeElement
  if (!active || active === document.body) return 'body'
  return active.closest('[role="tablist"]') ? 'tab-strip' : 'other'
}

function gitPanelShowing(): boolean {
  const { open, activeTabKey } = useRightPaneStore.getState()
  return open && activeTabKey?.kind === 'panel' && activeTabKey.id === 'git-changes'
}

function returnFocus(sessionId: string, value: string): void {
  const { group, path } = decodeOrigin(value)
  // Two frames: the tab strip's own focus move after a close runs in the next one.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!shouldReturnFocusToRow(gitPanelShowing(), focusLocation())) return
      if (!focusGitRowInGroup(sessionId, group, path) && !focusGitRow(sessionId, path)) focusNearestGroupTrigger(sessionId, group)
    })
  )
}

/** Remembers which Git changes row opened a diff tab, so closing it can send focus back (FR-006). */
export function rememberDiffOrigin(sessionId: string, tabId: string, group: GitChangesGroupKind, path: string): void {
  origins.set(originKey(sessionId, tabId), encodeOrigin(group, path))
  if (watching) return
  watching = true
  useDocumentTabsStore.subscribe((state) => {
    for (const { sessionId: closedSession, path: value } of takeClosedOrigins(origins, state.bySession)) returnFocus(closedSession, value)
  })
}

export function moveDiffOrigin(sessionId: string, fromId: string, toId: string, group: GitChangesGroupKind): void {
  moveOrigin(origins, sessionId, fromId, toId, group)
}
