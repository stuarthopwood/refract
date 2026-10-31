import type { ReactNode } from 'react'
import { InlineStatus } from '@/components/InlineStatus'

interface PinnedPanelShellProps {
  /** The pinned item, or null when nothing is pinned; `sessionId` is the Session it was opened from. */
  target: { sessionId: string | null } | null
  /** The Session now active in the chat; the note shows when it differs from the one that pinned. */
  activeSessionId: string | null
  emptyText: string
  /** Shown above the content, for example a jump to the full view. */
  toolbar?: ReactNode
  children: ReactNode
}

/** Shared frame for the pinned Pull request and Issue panels: empty state, "From another session" note, toolbar, content. */
export function PinnedPanelShell({ target, activeSessionId, emptyText, toolbar, children }: PinnedPanelShellProps) {
  if (!target) return <InlineStatus density="compact">{emptyText}</InlineStatus>
  const fromOtherSession = target.sessionId !== null && activeSessionId !== null && target.sessionId !== activeSessionId

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {fromOtherSession && <InlineStatus density="compact" tone="notice" className="shrink-0 border-b">From another session</InlineStatus>}
      {toolbar && <div className="no-drag-region shrink-0 border-b px-2 py-2">{toolbar}</div>}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
