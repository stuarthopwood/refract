import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ConversationInfo } from '../../../shared/model'
import { subscribeConversationsChanged } from '../chat/conversationChanges'

/** The list call can reject (a dropped IPC channel), which must surface as the same error state as a refused one. */
export async function readConversations(sessionId: string): Promise<{ ok: true; value: ConversationInfo[] } | { ok: false; message: string }> {
  try {
    const result = await window.refract.conversations.list(sessionId)
    return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
  }
}

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
  /** For callers that know a row is gone before the next read lands. */
  setConversations: Dispatch<SetStateAction<ConversationInfo[]>>
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
    const result = await readConversations(sessionId)
    if (!guard.isCurrent(ticket)) return
    if (result.ok) {
      setConversations(result.value)
      setError(null)
      setStatus('ready')
    } else {
      setError(result.message)
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
  return { conversations, setConversations, loading: status === 'loading' || (open && status === 'idle'), error, reload }
}
