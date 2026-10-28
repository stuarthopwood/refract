// Chat header (docs/DESIGN.md "Layout": "Chat header: Session name and branch, a Conversation
// switcher ..."). The shared `StateIcon` reads `SessionSummary` from the sessions store directly; New
// conversation and the Conversation history popover live in ConversationSwitcher. The pending
// Approval mode chip that used to live here moved to the ApprovalModePill above the message box
// (MessageInput.tsx, T098): that pill is the one place a mode change, pending or not, is shown.
// This header is also the right half of the app's merged top row (spec 001 T100, FR-057):
// draggable to move the window (its own buttons stay clickable via `.no-drag-region`), and a
// trailing spacer reserves the top-right corner for the window's minimise/maximise/close buttons
// -- spec 005/spec 013: only when `reservesWindowControls` is true, since a split's left pane
// never touches that corner, and the right-most pane's own copy of it stops reserving the corner
// while the right pane shell (`RightPaneShell.tsx`) is open -- its own header reserves the same
// corner instead, so exactly one of the two ever does (`App.tsx` computes this prop as
// `!rightPaneOpen`, spec 013 FR-011).
// No double-click handler here: verified live (tasks.md T100) that double-clicking this
// `.drag-region` already maximises/restores the window entirely at the OS level (HTCAPTION)
// before the double-click ever reaches the page's own JS, so a renderer-driven toggle was dead
// code and has been removed.
import { MessageSquareXIcon, SplitSquareHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/state'
import { STATUS_LABEL, StateIcon } from '@/features/sessions/sessionDisplay'
import { ConversationSwitcher } from './ConversationSwitcher'

interface ChatHeaderProps {
  sessionId: string
  /** Spec 005 (research.md Decision 9): set while a split is open; renders the "Focused" text
   * badge (never colour alone) when true. `undefined` while there is no split at all. */
  focused?: boolean
  /** Issue #621: always rendered now (removed the previous `isSplit`-only gate at the call
   * site, `ChatPane.tsx`) -- a single, non-split pane is independently closeable too, down to
   * the existing zero-session empty state. */
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
    <header className="drag-region flex h-10 shrink-0 items-center justify-between gap-2 px-4">
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
          // dark theme) against this same tinted background comfortably cleared 4.5:1 at the
          // time. Gate round 3 fix (Main, #1074 follow-up, item 4): `--foreground` itself is
          // now 90% alpha (#1074), and this badge's `active-indicator/20` fill is a coloured,
          // non-neutral surface -- FR-023's "stays solid" exception, same category as
          // `--send-foreground`/`--composer-selection-fg`, not the softened alias cascade. A
          // re-verified ratio on the translucent value isn't the fix: moved to the dedicated
          // `--active-indicator-foreground` token (plain solid white in every theme).
          <span className="shrink-0 rounded-full border border-active-indicator/40 bg-active-indicator/20 p-1 text-[10px] font-medium text-active-indicator-foreground">
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
            className="h-6 gap-2 px-2 text-xs"
            onClick={onSwapToOther}
            aria-label={`Switch to ${otherSessionName}`}
          >
            <SplitSquareHorizontalIcon aria-hidden className="size-4" />
            {otherSessionName}
          </Button>
        )}
        <div className="shrink-0">
          <ConversationSwitcher sessionId={sessionId} />
        </div>
        {onClose && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label={`Close ${session.name} chat pane`}
                aria-keyshortcuts="Control+W"
              >
                <MessageSquareXIcon aria-hidden className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Close {session.name} chat pane
              <KbdGroup>
                <Kbd>Ctrl</Kbd>
                <Kbd>W</Kbd>
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
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
