import { formatByteSize } from '@/lib/formatBytes'
import type { ConversationInfo } from '../../../shared/model'

/** Same wording as Rust's refusals, so a refusal reads the same before and after the request. */
export const CURRENT_CONVERSATION_REFUSAL = 'The current Conversation cannot be deleted.'
export const NOT_IDLE_REFUSAL = 'Delete Conversations after the current turn.'

export const conversationTitle = (conversation: ConversationInfo): string => conversation.title || 'Untitled conversation'

export function totalSizeBytes(conversations: readonly ConversationInfo[]): number {
  return conversations.reduce((sum, conversation) => sum + conversation.sizeBytes, 0)
}

/** Why `conversation` cannot be deleted right now, or `null` when it can (FR-187). */
export function deleteRefusal(conversation: ConversationInfo, sessionIdle: boolean): string | null {
  if (conversation.isCurrent) return CURRENT_CONVERSATION_REFUSAL
  if (!sessionIdle) return NOT_IDLE_REFUSAL
  return null
}

export function historySummary(conversations: readonly ConversationInfo[]): string {
  const count = conversations.length
  return `${count} ${count === 1 ? 'Conversation' : 'Conversations'} · ${formatByteSize(totalSizeBytes(conversations))} total`
}

export const freedMessage = (title: string, bytesFreed: number): string => `Deleted “${title}”. Freed ${formatByteSize(bytesFreed)}.`
