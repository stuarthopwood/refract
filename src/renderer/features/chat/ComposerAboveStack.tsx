// The stack mounted directly above the composer in `ChatPane.tsx`: the pinned todo panel
// (#700/#701), the Queued panel (#1145), the background-agents status banner (#865), then the
// current-work banner (#687), then the Agent stopped bar (#1205), last so it sits directly above
// the composer. One mount point so `ChatPane.tsx` (a baseline-capped file) does not grow.
import { BackgroundAgentsBanner } from '../subagents/BackgroundAgentsBanner'
import { AgentStoppedBar } from './AgentStoppedBar'
import { CurrentWorkBanner } from './CurrentWorkBanner'
import { LongConversationBanner } from './LongConversation'
import { PinnedTodoPanel } from './PinnedTodoPanel'
import { QueuedPanel } from './QueuedPanel'
import type { QueuedMessages } from './useQueuedMessages'

/** `stoppedBarAllowed` is false while a stop banner shows or a start is running (FR-105). */
export function ComposerAboveStack({ sessionId, stoppedBarAllowed, queued }: { sessionId: string; stoppedBarAllowed: boolean; queued: QueuedMessages }) {
  return (
    <>
      <PinnedTodoPanel sessionId={sessionId} />
      <QueuedPanel queued={queued} />
      <LongConversationBanner sessionId={sessionId} />
      <BackgroundAgentsBanner sessionId={sessionId} />
      <CurrentWorkBanner sessionId={sessionId} />
      <AgentStoppedBar sessionId={sessionId} allowed={stoppedBarAllowed} />
    </>
  )
}