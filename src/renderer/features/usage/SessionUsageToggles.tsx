// The Session usage panel's two segmented toggles (spec 123): scope and range. Both are the shared
// `ToggleGroup`, so Tab reaches each group and the arrow keys move within it. Radix emits '' when
// the selected segment is pressed again; a toggle always keeps one option, so that is ignored.
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { UsageSessionRange, UsageSessionScope } from '../../../shared/ipc-usage'

export interface SessionUsageTogglesProps {
  scope: UsageSessionScope
  range: UsageSessionRange
  /** False while the Session has no Conversation yet, which disables the Conversation option. */
  hasConversation: boolean
  onScopeChange(scope: UsageSessionScope): void
  onRangeChange(range: UsageSessionRange): void
}

export function SessionUsageToggles({ scope, range, hasConversation, onScopeChange, onRangeChange }: SessionUsageTogglesProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        type="single"
        size="sm"
        aria-label="Usage scope"
        value={hasConversation ? scope : 'session'}
        onValueChange={(next) => {
          if (next === 'session' || next === 'conversation') onScopeChange(next)
        }}
      >
        <ToggleGroupItem value="session">Session</ToggleGroupItem>
        <ToggleGroupItem
          value="conversation"
          disabled={!hasConversation}
          title={hasConversation ? undefined : 'This session has no conversation yet'}
        >
          Conversation
        </ToggleGroupItem>
      </ToggleGroup>
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
