import { MessageSquareXIcon, PauseIcon, PlayIcon, SearchIcon, SplitSquareHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PanelHeader, WINDOW_CONTROLS_OVERLAY_STYLE } from '@/components/PanelHeader'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/state'
import { closeChatFind, EMPTY_CHAT_FIND, openChatFind, useChatFindStore } from '@/state/chat-find-store'
import { displayLabel, displayStatus, StateIcon } from '@/features/sessions/sessionDisplay'
import { canTogglePause, setSessionPaused } from './pauseActions'
import { HiddenMarker } from '@/features/sessions/HiddenMarker'
import { ConversationSwitcher } from './ConversationSwitcher'

interface ChatHeaderProps {
  sessionId: string
  focused?: boolean
  onClose?: () => void
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
  const findOpen = useChatFindStore((s) => (s.bySession[sessionId] ?? EMPTY_CHAT_FIND).open)
  if (!session) return null

  return (
    <PanelHeader
      as="header"
      windowControlsSpacerStyle={reservesWindowControls ? WINDOW_CONTROLS_OVERLAY_STYLE : undefined}
      actions={
        <>
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
        {canTogglePause(session) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void setSessionPaused(sessionId, !session.pause)}
                aria-label={session.pause === 'pausing' ? `Cancel pause for ${session.name}` : session.pause ? `Resume ${session.name}` : `Pause ${session.name}`}
              >
                {session.pause ? <PlayIcon aria-hidden className="size-4" /> : <PauseIcon aria-hidden className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{session.pause === 'pausing' ? 'Cancel pause' : session.pause ? 'Resume' : 'Pause after this turn'}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={(event) => (findOpen ? closeChatFind(sessionId) : openChatFind(sessionId, event.currentTarget))}
              aria-label="Find in chat"
              aria-expanded={findOpen}
              aria-keyshortcuts="Control+F"
            >
              <SearchIcon aria-hidden className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Find in chat
            <KbdGroup>
              <Kbd>Ctrl</Kbd>
              <Kbd>F</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
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
        </>
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <StateIcon status={displayStatus(session)} />
        <span className="sr-only">{displayLabel(session)}</span>
        <span className="min-w-0 truncate text-sm font-medium" title={session.name}>{session.name}</span>
        {session.hiddenAt && <HiddenMarker />}
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={session.branch}>{session.branch}</span>
        {focused && (
          <Badge variant="focused">Focused</Badge>
        )}
      </div>
    </PanelHeader>
  )
}
