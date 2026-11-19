// The Session usage panel's two segmented toggles (spec 123): scope and range. Both are the shared
// `ToggleGroup`, so Tab reaches each group and the arrow keys move within it. Radix emits '' when
// the selected segment is pressed again; a toggle always keeps one option, so that is ignored.
// A muted line under them says what the selected scope counts, since the segment names alone do not.
import { useId } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { UsageSessionRange, UsageSessionScope } from '../../../shared/ipc-usage'

const SCOPE_DESCRIPTION: Record<UsageSessionScope, string> = {
  session: 'All conversations in this session, with their subagents and advisors.',
  conversation: 'This conversation, with its subagents and advisors.',
  main: "This conversation's main agent only. Excludes subagents and advisors."
}
const NO_CONVERSATION = 'This session has no conversation yet.'

export interface SessionUsageTogglesProps {
  scope: UsageSessionScope
  range: UsageSessionRange
  /** False while the Session has no Conversation yet, which disables the Conversation option. */
  hasConversation: boolean
  onScopeChange(scope: UsageSessionScope): void
  onRangeChange(range: UsageSessionRange): void
}

export function SessionUsageToggles({ scope, range, hasConversation, onScopeChange, onRangeChange }: SessionUsageTogglesProps) {
  const descriptionId = useId()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <ToggleGroup
          type="single"
          size="sm"
          aria-label="Usage scope"
          aria-describedby={descriptionId}
          value={hasConversation ? scope : 'session'}
          onValueChange={(next) => {
            if (next === 'session' || next === 'conversation' || next === 'main') onScopeChange(next)
          }}
        >
          <ToggleGroupItem value="session">Session</ToggleGroupItem>
          <ToggleGroupItem value="conversation" disabled={!hasConversation}>
            Conversation
          </ToggleGroupItem>
          <ToggleGroupItem value="main" disabled={!hasConversation}>
            Main agent
          </ToggleGroupItem>
        </ToggleGroup>
        {/* Two lines reserved so the cards below do not jump when the scope text changes length. */}
        <p id={descriptionId} className="min-h-8 text-xs text-muted-foreground">
          {hasConversation ? SCOPE_DESCRIPTION[scope] : NO_CONVERSATION}
        </p>
      </div>
      <ToggleGroup
        type="single"
        size="sm"
        aria-label="Usage range"
        value={range}
        onValueChange={(next) => {
          if (next === 'all' || next === 'today') onRangeChange(next)
        }}
      >
        <ToggleGroupItem value="all">All time</ToggleGroupItem>
        <ToggleGroupItem value="today">Today</ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
