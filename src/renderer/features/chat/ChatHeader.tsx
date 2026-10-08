// Chat header (docs/DESIGN.md "Layout": "Chat header: Session name and branch, a Conversation
// switcher ..."). The shared `StateIcon` reads `SessionSummary` from the sessions store directly; New
// conversation and the Conversation history popover live in ConversationSwitcher. The pending
// Approval mode chip that used to live here moved to the ApprovalModePill above the message box
// (MessageInput.tsx, T098): that pill is the one place a mode change, pending or not, is shown.
// This header is also the right half of the app's merged top row (spec 001 T100, FR-057):
// draggable to move the window (its own buttons stay clickable via `.no-drag-region`), and a
// trailing spacer reserves the top-right corner for the window's minimise/maximise/close buttons
// -- spec 005: only when `reservesWindowControls` is true, since a split's left pane no longer
// touches that corner (only the right pane, or the single pane when there is no split, does).
// No double-click handler here: verified live (tasks.md T100) that double-clicking this
// `.drag-region` already maximises/restores the window entirely at the OS level (HTCAPTION)
// before the double-click ever reaches the page's own JS, so a renderer-driven toggle was dead
// code and has been removed.
import { PanelRightCloseIcon, SplitSquareHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSessionsStore } from '@/state'
import { STATUS_LABEL, StateIcon } from '@/features/sessions/sessionDisplay'
import { ConversationSwitcher } from './ConversationSwitcher'

interface ChatHeaderProps {
  sessionId: string
  /** Spec 005 (research.md Decision 9): set while a split is open; renders the "Focused" text
   * badge (never colour alone) when true. `undefined` while there is no split at all. */
  focused?: boolean
  /** Spec 005 (FR-011, FR-013): renders a close-pane control when provided (only while split). */
  onClose?: () => void
  /** Spec 005 (FR-017, research.md Decision 6): the other (hidden) Session's name, while the
   * window is too narrow for two panes; renders a small swap chip when provided. */
  otherSessionName?: string
  onSwapToOther?: () => void
  reservesWindowControls: boolean
}

export function ChatHeader({
  sessionId,
  focused,
  onClose,
  otherSessionName,
  onSwapToOther,
  reservesWindowControls
}: ChatHeaderProps) {
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  if (!session) return null

  return (
    <header className="drag-region flex h-10 shrink-0 items-center justify-between gap-3 px-4">
      <div className="flex min-w-0 items-center gap-2">
        <StateIcon status={session.status} />
        <span className="sr-only">{STATUS_LABEL[session.status]}</span>
        <span className="truncate text-sm font-medium">{session.name}</span>
        <span className="shrink-0 truncate text-xs text-muted-foreground">{session.branch}</span>
        {focused && (
          // Quality-gate remediation (accessibility-auditor, Critical): the previous
          // `text-active-indicator` on `bg-active-indicator/15` composited to 2.69:1 against the
          // dark background -- below WCAG 1.4.3's 4.5:1 minimum for text, on the one marker this
          // spec relies on being readable without colour. `text-foreground` (near-white in the
          // dark theme) against this same tinted background comfortably clears 4.5:1.
          <span className="shrink-0 rounded-full border border-active-indicator/40 bg-active-indicator/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-foreground">
            Focused
          </span>
        )}
      </div>
      <div className="no-drag-region flex shrink-0 items-center gap-2">
        {otherSessionName && onSwapToOther && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={onSwapToOther}
            aria-label={`Switch to ${otherSessionName}`}
          >
            <SplitSquareHorizontalIcon aria-hidden className="size-3.5" />
            {otherSessionName}
          </Button>
        )}
        <div className="shrink-0">
          <ConversationSwitcher sessionId={sessionId} />
        </div>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={`Close ${session.name}'s pane`}
          >
            <PanelRightCloseIcon aria-hidden className="size-4" />
          </Button>
        )}
        {/* Reserves the top-right corner for the window's own minimise/maximise/close buttons
            (FR-057), sized from the exact overlay geometry Electron exposes once
            `titleBarOverlay` is set: the complement of its draggable width. Only the pane that
            actually touches that corner (the single pane, or a split's right pane) reserves it. */}
        {reservesWindowControls && (
          <div aria-hidden className="shrink-0" style={{ width: 'calc(100vw - env(titlebar-area-width, 100vw))' }} />
        )}
      </div>
    </header>
  )
}
