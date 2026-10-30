import * as React from 'react'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { CopyButton } from '@/components/ui/copy-button'
import { actionMenuItem } from '@/features/palette/menuItems'
import { cn } from '@/lib/utils'
import { useChatNavStore } from '@/state/chat-nav-store'
import { jumpToMessage } from '../chat-nav/jumpToMessage'
import { precedingUserMessageId } from '../chat-nav/messageIndex'
import { copyLinkText } from './linkClipboard'
import { markdownToPlainText } from './markdownPlainText'
import { TranscriptMenu } from './TranscriptMenu'

const NOTHING = 'Nothing to copy: this message only contains hidden characters'

function ScrollToPromptItem({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const promptId = precedingUserMessageId(useChatNavStore.getState().bySession[sessionId]?.index ?? [], messageId)
  if (!promptId) return null
  return (
    <>
      <ContextMenuSeparator />
      {actionMenuItem('transcript.scroll-to-prompt', { onSelect: () => void jumpToMessage(sessionId, promptId) })}
    </>
  )
}

interface MessageMenuProps {
  id: string
  /** The message's Markdown source, exactly what Copy puts on the clipboard. */
  text: string
  streaming?: boolean
  /** Set on agent replies: adds Scroll to your message. */
  sessionId?: string | null
  align?: 'start' | 'end'
  children: React.ReactNode
}

// A finished message's context menu plus the ghost Copy button in a row whose height is reserved
// while streaming too, so the transcript never jumps when a reply finishes. The button is a Tab
// stop: a bubble cannot take focus, so it is the keyboard anchor for Shift+F10 (#471).
export function MessageMenu({ id, text, streaming = false, sessionId, align = 'start', children }: MessageMenuProps) {
  const canCopy = !streaming && text.trim() !== ''
  return (
    <TranscriptMenu
      disabled={streaming}
      items={
        <>
          {actionMenuItem('transcript.copy-message', { onSelect: () => void copyLinkText(text, 'Message copied', NOTHING) })}
          {actionMenuItem('transcript.copy-message-plain', { onSelect: () => void copyLinkText(markdownToPlainText(text), 'Message copied as plain text', NOTHING) })}
          {sessionId ? <ScrollToPromptItem sessionId={sessionId} messageId={id} /> : null}
        </>
      }
    >
      {children}
      <div className={cn('mt-1 flex h-6', align === 'end' ? 'justify-end pr-10' : 'justify-start')}>
        {canCopy && (
          <CopyButton
            getText={() => text}
            label="Copy message"
            announcement="Message copied"
            className="text-muted-foreground opacity-0 transition-opacity motion-reduce:transition-none focus-visible:opacity-100 group-focus-within/transcript-menu:opacity-100 group-hover/transcript-menu:opacity-100 group-data-[state=open]/transcript-menu:opacity-100"
          />
        )}
      </div>
    </TranscriptMenu>
  )
}
