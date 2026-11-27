import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationInfo } from '../../../shared/model'
import { subscribeConversationsChanged } from '../chat/conversationChanges'

/** Numbers each request so only the newest one may apply its response. */
export function createStaleGuard() {
  let latest = 0
  return {
    next: () => ++latest,
    isCurrent: (ticket: number) => ticket === latest
  }
}

export interface SessionConversations {
  conversations: ConversationInfo[]
  loading: boolean
  error: string | null
  reload(): Promise<void>
}

type Status = 'idle' | 'loading' | 'ready' | 'error'

/** A Session's Conversations for its nested list: read on first open, and again on re-open or when they change. */
export function useSessionConversations(sessionId: string, open: boolean): SessionConversations {
  const [conversations, setConversations] = useState<ConversationInfo[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const guard = useRef(createStaleGuard()).current

  const reload = useCallback(async () => {
    const ticket = guard.next()
    setStatus('loading')
    const result = await window.refract.conversations.list(sessionId)
    if (!guard.isCurrent(ticket)) return
    if (result.ok) {
      setConversations(result.value)
      setError(null)
      setStatus('ready')
    } else {
      setError(result.error.message)
      setStatus('error')
    }
  }, [guard, sessionId])

  useEffect(() => {
    if (!open) return
    void reload()
    return subscribeConversationsChanged((changed) => {
      if (changed === sessionId) void reload()
    })
  }, [open, reload, sessionId])

  // A response that lands after unmount must not set state.
  useEffect(() => () => void guard.next(), [guard])

  // Before the first effect has run, an open list is already loading rather than empty.
  return { conversations, loading: status === 'loading' || (open && status === 'idle'), error, reload }
}
