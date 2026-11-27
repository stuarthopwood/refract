// Delete flow for the Conversation history (#2161, FR-186/FR-187): ask, confirm, then remove in the
// background (the row shows "Deleting…" and leaves the list when Rust reports the bytes freed).
import { useState, type Dispatch, type SetStateAction } from 'react'
import type { ConversationInfo } from '../../../shared/model'
import { conversationTitle, deleteRefusal, freedMessage } from './conversationDelete'

export interface DeleteNotice {
  tone: 'error' | 'notice'
  text: string
}

export function useConversationDelete(sessionId: string, sessionIdle: boolean, setConversations: Dispatch<SetStateAction<ConversationInfo[]>>) {
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
      setConversations((previous) => previous.filter((conversation) => conversation.file !== file))
      setNotice({ tone: 'notice', text: freedMessage(title, result.value.bytesFreed) })
    } finally {
      setDeleting((previous) => {
        const next = new Set(previous)
        next.delete(file)
        return next
      })
    }
  }

  return {
    target,
    deleting,
    notice,
    refusal: target ? deleteRefusal(target, sessionIdle) : null,
    ask: (conversation: ConversationInfo) => setTarget(conversation),
    cancel: () => setTarget(null),
    clearNotice: () => setNotice(null),
    confirm
  }
}
