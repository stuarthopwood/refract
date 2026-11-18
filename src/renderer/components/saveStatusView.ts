/** Where one Settings write is: not started (or its "Saved" has expired), in flight, landed, or failed. */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** How long "Saved" stays visible after a write lands; "Saving…" has no timer and lasts until the write returns. */
export const SAVED_VISIBLE_MS = 3000

export interface SaveStatusView {
  text: string
  /** An `InlineStatus` tone: loading and notice are polite `status`, error is an `alert`. */
  tone: 'loading' | 'notice' | 'error'
  icon: 'spinner' | 'check' | 'alert'
}

/** The text, tone and icon for a save state; `null` when there is nothing to say. */
export function describeSaveStatus(state: SaveState, error?: string): SaveStatusView | null {
  switch (state) {
    case 'saving':
      return { text: 'Saving…', tone: 'loading', icon: 'spinner' }
    case 'saved':
      return { text: 'Saved', tone: 'notice', icon: 'check' }
    case 'error':
      return { text: error ? `Could not save: ${error}` : 'Could not save', tone: 'error', icon: 'alert' }
    case 'idle':
      return null
  }
}
