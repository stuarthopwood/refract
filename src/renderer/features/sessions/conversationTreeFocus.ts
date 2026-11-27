import type { SessionSummary } from '../../../shared/ipc'

// DOM lookups for moving focus between a Session's open button and its nested Conversation entries.
// Entries are reached by arrow keys, not Tab, so focus is moved by element rather than by a roving tabindex.

export function conversationGroupId(sessionId: string): string {
  return `${sessionId}-conversations`
}

/** Archived Sessions and the Personal Agent have no nested Conversation list in v1. */
export function hasConversationList(session: Pick<SessionSummary, 'kind' | 'archivedAt'>): boolean {
  return session.kind === 'project' && !session.archivedAt
}

const ENTRY_SELECTOR = '[data-conversation-entry]'

/** The rendered entries under a Session in order: Conversations, then "Show all", "New conversation" or "Retry". */
export function conversationEntries(sessionId: string): HTMLElement[] {
  const group = document.getElementById(conversationGroupId(sessionId))
  return group ? Array.from(group.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)) : []
}

export function entryOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(ENTRY_SELECTOR) : null
}

export function focusFirstConversationEntry(sessionId: string): void {
  conversationEntries(sessionId)[0]?.focus()
}

export function focusSessionOpenButton(sessionId: string): void {
  document.querySelector<HTMLElement>(`[data-session-open="${CSS.escape(sessionId)}"]`)?.focus()
}

/** The next Session's open button in document order, or none when this is the last visible one. */
export function focusNextSessionOpenButton(sessionId: string): void {
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('.session-open-button'))
  const index = buttons.findIndex((button) => button.dataset.sessionOpen === sessionId)
  if (index !== -1) buttons[index + 1]?.focus()
}
