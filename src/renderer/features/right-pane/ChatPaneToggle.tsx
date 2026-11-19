// The Chat pane toggle: the second fixed rail button, under the Right pane toggle (spec 137 FR-015, FR-033).
import { useEffect, useRef } from 'react'
import { MessageSquareOffIcon, MessagesSquareIcon } from 'lucide-react'
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
  /** Why the toggle does nothing right now, or null when it works. Shown in the tooltip, so it stays focusable instead of natively disabled. */
  disabledReason: string | null
  onToggle: () => void
}

/** The reason the toggle is inert: no Session to hide or show chat for, or a view with no chat area to collapse. */
export function chatToggleDisabledReason(input: { canToggle: boolean; hasSession: boolean }): string | null {
  if (input.canToggle) return null
  return input.hasSession ? 'Switch to the chat view to hide or show chat' : 'Open a Session to show chat'
}

/** Presentational half, so the markup is testable without stores. The glyph swaps when chat is hidden, like the Right pane toggle's. */
export function ChatPaneToggleButton({ hidden, needsYou, disabledReason, onToggle }: ChatPaneToggleButtonProps) {
  const badge = chatBadgeCount({ hidden, needsYou })
  const Glyph = hidden ? MessageSquareOffIcon : MessagesSquareIcon
  return (
    <RailIconButton
      label={chatToggleLabel(badge)}
      tooltip={
        <>
          {CHAT_PANE_NAME} <Kbd>Ctrl+Shift+H</Kbd>
          <span className="block">{disabledReason ?? 'Pause and Stop stay in the command palette'}</span>
        </>
      }
      data-chat-toggle
      className="relative"
      aria-expanded={!hidden}
      aria-controls={CHAT_PANEL_DOM_ID}
      aria-keyshortcuts="Control+Shift+H"
      aria-disabled={disabledReason === null ? undefined : true}
      onClick={disabledReason === null ? onToggle : undefined}
    >
      <Glyph aria-hidden />
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
  const hasSession = paneSessionIds.length > 0
  const needsYou = useSessionsStore((s) => needsYouInPanes(paneSessionIds, s.sessions))
  useAttentionAnnouncement({ hidden, needsYou })
  const disabledReason = chatToggleDisabledReason({ canToggle, hasSession })
  return <ChatPaneToggleButton hidden={hidden} needsYou={needsYou} disabledReason={disabledReason} onToggle={() => toggleChatPane()} />
}
