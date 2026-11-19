import { openDocument } from '../../documents/open-document'
import { RIGHT_PANE_CONTENT_SELECTOR } from '@/lib/right-pane-selectors'
import { rememberRowOrigin } from './row-focus-return'

export interface RowActivation {
  /** Enter or Space, as opposed to a pointer click. */
  keyboard: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export interface RowOpenOptions {
  /** Ctrl+click and Ctrl+Enter: the tab opens in the background while the list keeps focus. */
  background: boolean
  /** A pointer click leaves focus on the row; only the keyboard moves it to the new tab. */
  focus: boolean
}

type Modifiers = Pick<RowActivation, 'ctrlKey' | 'metaKey'>

export const pointerActivation = ({ ctrlKey, metaKey }: Modifiers): RowActivation => ({ keyboard: false, ctrlKey, metaKey })
export const keyboardActivation = ({ ctrlKey, metaKey }: Modifiers): RowActivation => ({ keyboard: true, ctrlKey, metaKey })

export function rowOpenOptions(activation: RowActivation): RowOpenOptions {
  return { background: activation.ctrlKey || activation.metaKey, focus: activation.keyboard }
}

/** The shell focuses a tab it adds, but not one that was already open, so the keyboard path has to do that itself. */
export function needsContentFocus(options: RowOpenOptions, existed: boolean): boolean {
  return existed && options.focus && !options.background
}

/** Opens a file row as a persistent tab (FR-005). */
export function openFileFromRow(sessionId: string, path: string, activation: RowActivation): void {
  const options = rowOpenOptions(activation)
  const announce = options.background ? `Opened ${path.split('/').pop() ?? path} in the background` : undefined
  const result = openDocument(sessionId, { kind: 'file', path }, { background: options.background, focus: options.focus, announce })
  rememberRowOrigin(sessionId, result.id, path)
  if (needsContentFocus(options, result.existed)) requestAnimationFrame(() => document.querySelector<HTMLElement>(RIGHT_PANE_CONTENT_SELECTOR)?.focus())
}
