import { openDocument } from '../../documents/open-document'
import { focusExistingDocumentTab } from '../document-tab-focus'
import { keyboardActivation, needsExistingTabFocus, pointerActivation, rowOpenOptions, type RowActivation } from '../file-explorer/row-open'
import type { GitChangesGroupKind } from '../../../../shared/model'
import { rememberDiffOrigin } from './diff-row-focus-return'

/** A click with no pointer position (`detail` 0) is the browser's own Enter or Space activation, which keeps Ctrl held for Ctrl+Enter. */
export function clickActivation(event: { detail: number; ctrlKey: boolean; metaKey: boolean }): RowActivation {
  return (event.detail === 0 ? keyboardActivation : pointerActivation)(event)
}

/** Enter on a row's button; null for every other key, which keeps its native behaviour (Space still clicks). */
export function enterActivation(event: { key: string; ctrlKey: boolean; metaKey: boolean }): RowActivation | null {
  return event.key === 'Enter' ? keyboardActivation(event) : null
}

export function diffOpenAnnouncement(path: string, background: boolean): string | undefined {
  return background ? `Opened diff of ${path.split('/').pop() ?? path} in the background` : undefined
}

/** Opens a Git changes row as a persistent diff tab with the same opener rules as a file row (FR-006). */
export function openDiffFromRow(sessionId: string, group: GitChangesGroupKind, path: string, activation: RowActivation): void {
  const options = rowOpenOptions(activation)
  const result = openDocument(
    sessionId,
    { kind: 'diff', group, path },
    { background: options.background, focus: options.focus, announce: diffOpenAnnouncement(path, options.background) }
  )
  rememberDiffOrigin(sessionId, result.id, group, path)
  if (needsExistingTabFocus(options, result.existed)) focusExistingDocumentTab(sessionId, result.id)
}
