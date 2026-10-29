// The stack mounted directly above the composer in `ChatPane.tsx`: the pinned todo panel
// (#700/#701), the background-agents status banner (#865), then the current-work banner (#687), then
// the Agent stopped bar (#1205), last so it sits directly above the composer. One mount point so
// `ChatPane.tsx` (a baseline-capped file) does not grow.
import { BackgroundAgentsBanner } from '../subagents/BackgroundAgentsBanner'
import { AgentStoppedBar } from './AgentStoppedBar'
import { CurrentWorkBanner } from './CurrentWorkBanner'
import { LongConversationBanner } from './LongConversation'
import { PinnedTodoPanel } from './PinnedTodoPanel'

/** `stoppedBarAllowed` is false while a stop banner shows or a start is running (FR-105). */
export function ComposerAboveStack({ sessionId, stoppedBarAllowed }: { sessionId: string; stoppedBarAllowed: boolean }) {
  return (
    <>
      <PinnedTodoPanel sessionId={sessionId} />
      <LongConversationBanner sessionId={sessionId} />
      <BackgroundAgentsBanner sessionId={sessionId} />
      <CurrentWorkBanner sessionId={sessionId} />
      <AgentStoppedBar sessionId={sessionId} allowed={stoppedBarAllowed} />
    </>
  )
}
