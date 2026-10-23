// The stack mounted directly above the composer in `ChatPane.tsx`: the pinned todo panel
// (#700/#701), then the current-work banner (#687). One mount point so `ChatPane.tsx` (a
// baseline-capped file) does not grow.
import { CurrentWorkBanner } from './CurrentWorkBanner'
import { LongConversationBanner } from './LongConversation'
import { PinnedTodoPanel } from './PinnedTodoPanel'

export function ComposerAboveStack({ sessionId }: { sessionId: string }) {
  return (
    <>
      <PinnedTodoPanel sessionId={sessionId} />
      <LongConversationBanner sessionId={sessionId} />
      <CurrentWorkBanner sessionId={sessionId} />
    </>
  )
}
