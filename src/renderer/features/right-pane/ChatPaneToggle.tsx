// The Chat pane toggle: the second fixed rail button, under the Right pane toggle (spec 137 FR-015, FR-033).
import { useEffect, useRef } from 'react'
import { MessagesSquareIcon } from 'lucide-react'
import { RailIconButton } from '@/components/RailIconButton'
import { Kbd } from '@/components/ui/kbd'
import { CountBadge } from '@/components/ui/count-badge'
import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { useSessionsStore } from '@/state/sessions-store'
import { useSplitStore } from '@/state/split-store'
import { CHAT_PANEL_DOM_ID } from './chat-panel-id'
import { CHAT_PANE_NAME, chatAttentionAnnouncement, chatBadgeCount, chatToggleLabel, needsYouInPanes, type ChatAttention } from './chat-attention'
import { toggleChatPane, useCanToggleChatPane, useChatPaneHidden } from './toggle-chat-pane'

interface ChatPaneToggleButtonProps extends ChatAttention {
  disabled: boolean
  onToggle: () => void
}

/** Presentational half, so the markup is testable without stores. */
export function ChatPaneToggleButton({ hidden, needsYou, disabled, onToggle }: ChatPaneToggleButtonProps) {
  const badge = chatBadgeCount({ hidden, needsYou })
  return (
    <RailIconButton
      label={chatToggleLabel(badge)}
      tooltip={
        <>
          {CHAT_PANE_NAME} <Kbd>Ctrl+Shift+H</Kbd>
          <span className="block">Pause and Stop stay in the command palette</span>
        </>
      }
      data-chat-toggle
      className="relative"
      aria-expanded={!hidden}
      aria-controls={CHAT_PANEL_DOM_ID}
      aria-keyshortcuts="Control+Shift+H"
      disabled={disabled}
      onClick={onToggle}
    >
      <MessagesSquareIcon aria-hidden />
      {badge > 0 && <CountBadge value={badge} tone="accent" />}
    </RailIconButton>
  )
}

function useAttentionAnnouncement(current: ChatAttention): void {
  const previous = useRef(current)
  useEffect(() => {
    const message = chatAttentionAnnouncement(previous.current, current)
    previous.current = current
    if (message) useAgentAnnouncementStore.getState().announce(message)
  }, [current.hidden, current.needsYou])
}

export function ChatPaneToggle() {
  const hidden = useChatPaneHidden()
  const canToggle = useCanToggleChatPane()
  const paneSessionIds = useSplitStore((s) => s.paneSessionIds)
  const needsYou = useSessionsStore((s) => needsYouInPanes(paneSessionIds, s.sessions))
  useAttentionAnnouncement({ hidden, needsYou })
  return <ChatPaneToggleButton hidden={hidden} needsYou={needsYou} disabled={!canToggle} onToggle={() => toggleChatPane()} />
}
