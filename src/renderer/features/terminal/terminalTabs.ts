import type { TabInfo, TabState, TerminalApi, TerminalCloseResult } from '../../../shared/ipc-terminal'
import { NAME_MAX_CHARS } from '../../../shared/terminalLimits'

// Pure rules behind the tab strip, kept out of the component so they run without a browser (spec 144 FR-003, FR-009, FR-012).

export interface TabMarker {
  /** Spoken after the tab name; `null` for a healthy running shell, which needs no extra word. */
  label: string | null
  tone: 'running' | 'starting' | 'ended' | 'failed'
}

export function tabMarker(state: TabState): TabMarker {
  switch (state.kind) {
    case 'starting':
      return { label: 'starting', tone: 'starting' }
    case 'running':
      return { label: null, tone: 'running' }
    case 'ended':
      return { label: `ended with code ${state.code}`, tone: 'ended' }
    case 'failed':
      return { label: 'failed to start', tone: 'failed' }
  }
}

/** Where arrow, Home and End keys move the selection in a horizontal tab list; `null` for any other key. */
export function tabIndexForKey(key: string, index: number, count: number): number | null {
  if (count < 1) return null
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count
    case 'ArrowLeft':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** The name to save for a rename, or `null` when nothing should be sent (blank, unchanged). Over-long names are cut to the limit. */
export function renamedValue(draft: string, current: string): string | null {
  const trimmed = draft.trim().slice(0, NAME_MAX_CHARS).trim()
  return trimmed === '' || trimmed === current ? null : trimmed
}

export type RenameEnd = 'enter' | 'escape' | 'blur'

/**
 * What ending a rename means: the name to save (`null` sends nothing) and whether the tab takes the keyboard back.
 * A blur means the user went elsewhere on purpose, so the tab must not pull focus back.
 */
export function renameOutcome(draft: string, current: string, end: RenameEnd): { name: string | null; refocusTab: boolean } {
  return { name: end === 'escape' ? null : renamedValue(draft, current), refocusTab: end !== 'blur' }
}

/** DOM ids that tie the shown tab to its panel; a tab names its panel only while that panel is mounted. */
export const tabDomId = (tabId: string): string => `terminal-tab-${tabId}`
export const panelDomId = (tabId: string): string => `terminal-panel-${tabId}`

export type CloseOutcome = { kind: 'closed' } | { kind: 'confirm' } | { kind: 'failed'; message: string }

/** One close call. A tab with a running job comes back as `confirm` and stays alive until the caller asks again with `force`. */
export async function closeTab(api: Pick<TerminalApi, 'close'>, tab: Pick<TabInfo, 'id'>, force: boolean): Promise<CloseOutcome> {
  const result = await api.close(tab.id, force)
  if (!result.ok) return { kind: 'failed', message: result.error.message }
  const value: TerminalCloseResult = result.value
  if (value.closed) return { kind: 'closed' }
  return value.needsConfirm ? { kind: 'confirm' } : { kind: 'failed', message: 'The terminal did not close.' }
}
