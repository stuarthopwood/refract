import { MessageStepButtons } from './MessageStepButtons'
import { ChatFind } from './search/ChatFind'

/** Everything chat navigation floats over the transcript; render inside the MessageScroller root. */
export function ChatNavOverlays({ sessionId }: { sessionId: string }) {
  return (
    <>
      <MessageStepButtons sessionId={sessionId} />
      <ChatFind sessionId={sessionId} />
    </>
  )
}
