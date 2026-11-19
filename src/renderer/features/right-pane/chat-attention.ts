// Spec 137 FR-033 (#2075): the Chat pane toggle's attention badge. Pure helpers; the rail toggle wires them.
import type { SessionSummary } from '../../../shared/ipc'
import { isNeedsYouSession } from '../sessions/sessionDisplay'
import { needsYouLabel } from '../sessions/sessionTree'

export const CHAT_PANE_NAME = 'Chat pane'

export interface ChatAttention {
  hidden: boolean
  /** Needs-you Sessions in the visible Chat panes (one, or two in a Split), whether or not chat is hidden. */
  needsYou: number
}

export function needsYouInPanes(paneSessionIds: readonly string[], sessions: readonly SessionSummary[]): number {
  const visible = new Set(paneSessionIds)
  return sessions.reduce((count, session) => (visible.has(session.id) && isNeedsYouSession(session) ? count + 1 : count), 0)
}

/** The badge number: nothing while chat shows, because the Session is then on screen. */
export function chatBadgeCount({ hidden, needsYou }: ChatAttention): number {
  return hidden ? needsYou : 0
}

/** The accessible name keeps the base "Chat pane" and appends the shared needs-you wording, so the count is not colour- or glyph-only. */
export function chatToggleLabel(badge: number): string {
  const attention = needsYouLabel(badge)
  return attention ? `${CHAT_PANE_NAME}, ${attention}` : CHAT_PANE_NAME
}

/** One polite message when attention rises while chat stays hidden; hiding or showing already announces itself, and a clear is silent. */
export function chatAttentionAnnouncement(previous: ChatAttention, next: ChatAttention): string | null {
  return previous.hidden && next.hidden && next.needsYou > previous.needsYou ? chatToggleLabel(next.needsYou) : null
}
