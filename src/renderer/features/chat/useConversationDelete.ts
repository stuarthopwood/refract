// Delete flow for the Conversation history (#2161, FR-186/FR-187): ask, confirm, then remove in the
// background (the row shows "Deleting…" and leaves the list when Rust reports the bytes freed).
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import type { ConversationInfo } from '../../../shared/model'
import { conversationTitle, deleteRefusal, freedMessage } from './conversationDelete'
import { emitConversationsChanged } from './conversationChanges'

export interface ConversationDelete {
  /** The Conversation awaiting confirmation (or refusal), if any. */
  target: ConversationInfo | null
  deleting: ReadonlySet<string>
  status: string
  failure: string
  refusal: string | null
  ask(conversation: ConversationInfo): void
  cancel(): void
  clearNotice(): void
  confirm(): Promise<void>
}

interface DeleteNotice {
  tone: 'error' | 'notice'
  text: string
}

/** `onRemoved` runs just before the row leaves the list, so the caller can pick where focus goes next. */
export function useConversationDelete(
  sessionId: string,
  sessionIdle: boolean,
  setConversations: Dispatch<SetStateAction<ConversationInfo[]>>,
  onRemoved: (file: string) => void
): ConversationDelete {
  const [target, setTarget] = useState<ConversationInfo | null>(null)
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<DeleteNotice | null>(null)

  async function confirm() {
    if (!target || deleteRefusal(target, sessionIdle)) return
    const { file } = target
    const title = conversationTitle(target)
    setTarget(null)
    setNotice(null)
    setDeleting((previous) => new Set(previous).add(file))
    try {
      const result = await window.refract.conversations.delete(sessionId, file)
      if (!result.ok) {
        setNotice({ tone: 'error', text: result.error.message })
        return
      }
      onRemoved(file)
      setConversations((previous) => previous.filter((conversation) => conversation.file !== file))
      emitConversationsChanged(sessionId)
      setNotice({ tone: 'notice', text: freedMessage(title, result.value.bytesFreed) })
    } finally {
      setDeleting((previous) => {
        const next = new Set(previous)
        next.delete(file)
        return next
      })
    }
  }

  const ask = useCallback((conversation: ConversationInfo) => setTarget(conversation), [])

  return {
    target,
    deleting,
    // Two separate texts so the page can keep one polite and one assertive live region mounted.
    status: notice?.tone === 'notice' ? notice.text : '',
    failure: notice?.tone === 'error' ? notice.text : '',
    refusal: target ? deleteRefusal(target, sessionIdle) : null,
    ask,
    cancel: () => setTarget(null),
    clearNotice: () => setNotice(null),
    confirm
  }
}
