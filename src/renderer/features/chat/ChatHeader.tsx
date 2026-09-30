// Chat header (docs/DESIGN.md "Layout": "Chat header: Session name and branch, a Conversation
// switcher ..., and a small chip when an Approval mode change is pending"). The status dot and
// pending-mode chip read `SessionSummary` from the sessions store directly; New conversation and
// the Conversation history popover live in ConversationSwitcher.
import type { ApprovalMode, SessionStatus } from '../../../shared/model'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/state'
import { ConversationSwitcher } from './ConversationSwitcher'

const STATUS_DOT_CLASS: Record<SessionStatus, string> = {
  idle: 'bg-state-idle',
  working: 'bg-state-working',
  'needs-you': 'bg-state-needs-you',
  stopped: 'bg-state-stopped'
}

const MODE_LABEL: Record<ApprovalMode, string> = {
  ask: 'Ask',
  'edit-freely': 'Edit freely',
  auto: 'Auto'
}

export function ChatHeader({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  if (!session) return null

  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[session.status])}
          aria-hidden="true"
          title={session.status}
        />
        <span className="truncate text-sm font-medium">{session.name}</span>
        <span className="shrink-0 truncate text-xs text-muted-foreground">{session.branch}</span>
        {session.pendingMode && (
          <Badge variant="outline" className="shrink-0">
            {MODE_LABEL[session.pendingMode]} after this turn
          </Badge>
        )}
      </div>
      <ConversationSwitcher sessionId={sessionId} />
    </header>
  )
}
