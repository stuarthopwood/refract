import { EMPTY_CHAT_FIND, useChatFindStore } from '@/state/chat-find-store'
import { FindBar } from './FindBar'
import { useChatFindShortcut } from './useChatFindShortcut'

/** Shows the Session's find bar while it is open and listens for Ctrl+F. */
export function ChatFind({ sessionId }: { sessionId: string }) {
  useChatFindShortcut(sessionId)
  const open = useChatFindStore((state) => (state.bySession[sessionId] ?? EMPTY_CHAT_FIND).open)
  return open ? <FindBar sessionId={sessionId} /> : null
}
