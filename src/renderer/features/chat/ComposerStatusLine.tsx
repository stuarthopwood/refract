import { useSettingsStore } from '@/state'
import type { RefObject } from 'react'
import {
  AdvisorReadout,
  ChangesReadout,
  CurrentTimeReadout,
  PullRequestReadout,
  SubagentsReadout,
  TodoProgressReadout,
  TurnTimeReadout
} from './readout/Readouts'
import { ContextUsageReadout } from './readout/ContextUsageReadout'
import { AiCreditsReadout } from './readout/AiCreditsReadout'
import { LongConversationChip } from './LongConversation'
import { AgentMemoryReadout, RpcSlowReadout } from './readout/HealthReadouts'

export function ComposerStatusLine({ sessionId, textareaRef }: { sessionId: string; textareaRef: RefObject<HTMLTextAreaElement | null> }) {
  const sessionReadout = useSettingsStore((s) => s.settings.sessionReadout)
  return (
    <div data-slot="composer-status-line" className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 empty:hidden tabular-nums">
      {sessionReadout['todo-progress'] && <TodoProgressReadout sessionId={sessionId} />}
      {sessionReadout.changes && <ChangesReadout sessionId={sessionId} />}
      {sessionReadout['context-usage'] && <ContextUsageReadout sessionId={sessionId} />}
      <AiCreditsReadout sessionId={sessionId} />
      {sessionReadout['turn-time'] && <TurnTimeReadout sessionId={sessionId} />}
      {sessionReadout.subagents && <SubagentsReadout sessionId={sessionId} />}
      {sessionReadout['pull-request'] && <PullRequestReadout sessionId={sessionId} />}
      <AdvisorReadout sessionId={sessionId} textareaRef={textareaRef} />
      <LongConversationChip sessionId={sessionId} />
      <RpcSlowReadout sessionId={sessionId} />
      <AgentMemoryReadout sessionId={sessionId} />
      {sessionReadout['current-time'] && <CurrentTimeReadout className="ml-auto" />}
    </div>
  )
}
