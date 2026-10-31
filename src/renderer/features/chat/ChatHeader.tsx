import { MessageSquareXIcon, PauseIcon, PlayIcon, SearchIcon, SplitSquareHorizontalIcon, Undo2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PanelHeader, WINDOW_CONTROLS_OVERLAY_STYLE } from '@/components/PanelHeader'
import { IconButton } from '@/components/IconButton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionsStore } from '@/state'
import { closeChatFind, EMPTY_CHAT_FIND, openChatFind, useChatFindStore } from '@/state/chat-find-store'
import { displayLabel, displayStatus, StateIcon } from '@/features/sessions/sessionDisplay'
import type { PauseState } from '../../../shared/ipc-pause'
import { canTogglePause, setSessionPaused } from './pauseActions'
import { HiddenMarker } from '@/features/sessions/HiddenMarker'
import { ConversationSwitcher } from './ConversationSwitcher'
import { HeaderPrControls } from './header/HeaderPrControls'

interface ChatHeaderProps {
  sessionId: string
  focused?: boolean
  onClose?: () => void
  otherSessionName?: string
  onSwapToOther?: () => void
  reservesWindowControls: boolean
}

function pauseLabel(pause: PauseState | undefined, name: string): string {
  if (pause === 'pausing') return `Cancel pause for ${name}`
  return pause ? `Resume ${name}` : `Pause ${name} after this turn`
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
      className="@container/chat"
      windowControlsSpacerStyle={reservesWindowControls ? WINDOW_CONTROLS_OVERLAY_STYLE : undefined}
      actions={
        <>
          {otherSessionName && onSwapToOther && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 max-w-40 gap-2 px-2 text-xs"
                  onClick={onSwapToOther}
                  aria-label={`Switch to ${otherSessionName}`}
                  aria-describedby={undefined}
                >
                  <SplitSquareHorizontalIcon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{otherSessionName}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{`Switch to ${otherSessionName}`}</TooltipContent>
            </Tooltip>
          )}
          <HeaderPrControls sessionId={sessionId} />
          <div className="shrink-0">
            <ConversationSwitcher sessionId={sessionId} />
          </div>
          {canTogglePause(session) && (
            <IconButton
              label={pauseLabel(session.pause, session.name)}
              onClick={() => void setSessionPaused(sessionId, !session.pause)}
            >
              {session.pause === 'pausing' ? <Undo2Icon aria-hidden className="size-4" /> : session.pause ? <PlayIcon aria-hidden className="size-4" /> : <PauseIcon aria-hidden className="size-4" />}
            </IconButton>
          )}
          <IconButton
            label="Find in chat"
            shortcut={['Ctrl', 'F']}
            onClick={(event) => (findOpen ? closeChatFind(sessionId) : openChatFind(sessionId, event.currentTarget))}
            aria-expanded={findOpen}
          >
            <SearchIcon aria-hidden className="size-4" />
          </IconButton>
          {onClose && (
            <IconButton label={`Close ${session.name} chat pane`} shortcut={['Ctrl', 'W']} onClick={onClose}>
              <MessageSquareXIcon aria-hidden className="size-4" />
            </IconButton>
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
