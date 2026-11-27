// Pure parts of the Conversation tree view: ordering and indent, the refusal texts, the label save rule and
// how a Rewind's recovered message lands in the composer. Kept apart from the components so they test without a DOM.
import type { IpcError, Result } from '../../../shared/ipc'
import type { ConversationTreeEntry } from '../../../shared/model'

export const NOT_IDLE_TREE_REASON = 'Rewind and Fork are available only while the agent is idle.'
export const NO_AGENT_TREE_MESSAGE = 'The agent is not running, so there is no Conversation tree to show. Open the Session to start it.'
export const FILES_NOT_CHANGED = 'Files in the worktree are not changed.'
/** Deepest indent step shown; a long chain of replies would otherwise push the text off the row. */
export const MAX_TREE_INDENT = 6

// OMP message roles the tree projection can carry (`unknown` is its own fallback for a message without one).
const ROLE_LABELS: Record<string, string> = {
  user: 'You',
  assistant: 'Agent',
  toolResult: 'Tool result',
  bashExecution: 'Shell command',
  pythonExecution: 'Python run',
  branchSummary: 'Summary',
  compactionSummary: 'Summary',
  custom: 'Note',
  developer: 'System',
  hookMessage: 'Hook'
}
const UNKNOWN_ROLE_LABEL = 'Other'

/** A person-readable name for a message role; a role this view does not know reads generically, never as its raw id. */
export function roleLabel(role: string): string {
  return (Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role] : undefined) ?? UNKNOWN_ROLE_LABEL
}

/** Indent step per entry. Entries arrive parents-first, so one pass over `parentId` is enough. */
export function treeDepths(entries: ConversationTreeEntry[]): Map<string, number> {
  const depths = new Map<string, number>()
  for (const entry of entries) {
    const parentDepth = entry.parentId === null ? undefined : depths.get(entry.parentId)
    depths.set(entry.id, parentDepth === undefined ? 0 : parentDepth + 1)
  }
  return depths
}

/** `not-idle` carries the same reason the buttons show and `agent-not-running` (a stopped Session) says what to do; every other refusal keeps the message the backend wrote. */
export function treeActionMessage(error: IpcError): string {
  if (error.code === 'not-idle') return NOT_IDLE_TREE_REASON
  return error.code === 'agent-not-running' ? NO_AGENT_TREE_MESSAGE : error.message
}

export type LabelApi = (sessionId: string, entryId: string, label: string) => Promise<Result<null>>

/** What saving `draft` over `entry` does: nothing when it is unchanged, otherwise the trimmed text (empty clears the label). */
export function labelToSave(current: string | null, draft: string): string | null {
  const next = draft.trim()
  return next === (current ?? '') ? null : next
}

/** Saves an edited label; resolves to the failure text, or null when it saved or there was nothing to save. */
export async function saveEntryLabel(label: LabelApi, sessionId: string, entry: ConversationTreeEntry, draft: string): Promise<string | null> {
  const next = labelToSave(entry.label, draft)
  if (next === null) return null
  const result = await label(sessionId, entry.id, next)
  return result.ok ? null : treeActionMessage(result.error)
}

/** A Rewind brings the message back into the composer without discarding what is already typed there. */
export function composerTextAfterRewind(existing: string, editorText: string | null): string {
  if (!editorText) return existing
  return existing.trim() === '' ? editorText : `${editorText}\n\n${existing}`
}
