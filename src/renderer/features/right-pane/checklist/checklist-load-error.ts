/** What the developer is told when the checklist cannot be loaded; Rust's own message is never shown. */
export interface LoadErrorCopy {
  message: string
  /** A newer on-disk format is not fixed by asking again. */
  retryable: boolean
}

const UNSUPPORTED_CODE = 'store-unsupported'

/** Copy for a failed `checklist.get`, by error code; `showingLast` says a held checklist stays on screen. */
export function loadErrorCopy(code: string | null, showingLast: boolean): LoadErrorCopy {
  if (code === UNSUPPORTED_CODE) return { message: 'This checklist was saved by a newer version of Refract. Update Refract to see it.', retryable: false }
  return { message: showingLast ? "Couldn't refresh the checklist. Showing the last version." : "Couldn't read this session's checklist.", retryable: true }
}

export const TOOL_UNAVAILABLE_COPY = "The agent can't use checklists in this session. Restart the session to try again."
