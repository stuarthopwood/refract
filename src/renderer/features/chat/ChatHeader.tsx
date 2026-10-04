// Chat header (docs/DESIGN.md "Layout": "Chat header: Session name and branch, a Conversation
// switcher ..."). The shared `StateIcon` reads `SessionSummary` from the sessions store directly; New
// conversation and the Conversation history popover live in ConversationSwitcher. The pending
// Approval mode chip that used to live here moved to the ApprovalModePill above the message box
// (MessageInput.tsx, T098): that pill is the one place a mode change, pending or not, is shown.
// This header is also the right half of the app's merged top row (spec 001 T100, FR-057):
// draggable to move the window (its own buttons stay clickable via `.no-drag-region`), and a
// trailing spacer reserves the top-right corner for the window's minimise/maximise/close buttons.
// No double-click handler here: verified live (tasks.md T100) that double-clicking this
// `.drag-region` already maximises/restores the window entirely at the OS level (HTCAPTION)
// before the double-click ever reaches the page's own JS, so a renderer-driven toggle was dead
// code and has been removed.
import { useSessionsStore } from '@/state'
import { STATUS_LABEL, StateIcon } from '@/features/sessions/sessionDisplay'
import { ConversationSwitcher } from './ConversationSwitcher'

export function ChatHeader({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  if (!session) return null

  return (
    <header className="drag-region flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-2">
        <StateIcon status={session.status} />
        <span className="sr-only">{STATUS_LABEL[session.status]}</span>
        <span className="truncate text-sm font-medium">{session.name}</span>
        <span className="shrink-0 truncate text-xs text-muted-foreground">{session.branch}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="no-drag-region shrink-0">
          <ConversationSwitcher sessionId={sessionId} />
        </div>
        {/* Reserves the top-right corner for the window's own minimise/maximise/close buttons
            (FR-057), sized from the exact overlay geometry Electron exposes once
            `titleBarOverlay` is set: the complement of its draggable width. */}
        <div aria-hidden className="no-drag-region shrink-0" style={{ width: 'calc(100vw - env(titlebar-area-width, 100vw))' }} />
      </div>
    </header>
  )
}
