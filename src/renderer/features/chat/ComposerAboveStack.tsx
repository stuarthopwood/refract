// The stack mounted directly above the composer in `ChatPane.tsx`: the pinned todo panel, the Queued panel, the current-work
// banner, then the Agent stopped bar, last so it sits directly above the composer. Background agents live in the Subagents card
// and panel, not here. One mount point so `ChatPane.tsx` (a baseline-capped file) does not grow.
import { AgentStoppedBar } from './AgentStoppedBar'
import { AdvisorRosterNotice } from './AdvisorRosterNotice'
import { CurrentWorkBanner } from './CurrentWorkBanner'
import { LongConversationBanner } from './LongConversation'
import { PinnedTodoPanel } from './PinnedTodoPanel'
import { QueuedPanel } from './QueuedPanel'
import { RetryLine } from './RetryLine'
import type { QueuedMessages } from './useQueuedMessages'

/** `stoppedBarAllowed` is false while a stop banner shows or a start is running. */
export function ComposerAboveStack({ sessionId, stoppedBarAllowed, queued }: { sessionId: string; stoppedBarAllowed: boolean; queued: QueuedMessages }) {
  return (
    <>
      <PinnedTodoPanel sessionId={sessionId} />
      <QueuedPanel queued={queued} />
      <LongConversationBanner sessionId={sessionId} />
      <AdvisorRosterNotice sessionId={sessionId} />
      <CurrentWorkBanner sessionId={sessionId} />
      <RetryLine sessionId={sessionId} />
      <AgentStoppedBar sessionId={sessionId} allowed={stoppedBarAllowed} />
    </>
  )
}