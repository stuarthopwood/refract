import * as React from 'react'
import { CopyButton } from '@/components/ui/copy-button'
import { actionMenuItem, menuSeparator, type MenuKind } from '@/features/palette/menuItems'
import { cn } from '@/lib/utils'
import { useChatNavStore } from '@/state/chat-nav-store'
import { jumpToMessage } from '../chat-nav/jumpToMessage'
import { precedingUserMessageId } from '../chat-nav/messageIndex'
import { copyLinkText } from './linkClipboard'
import { markdownToPlainText } from './markdownPlainText'
import { TranscriptKebab, TranscriptMenu } from './TranscriptMenu'

const NOTHING = 'Nothing to copy: this message only contains hidden characters'

function ScrollToPromptItem({ sessionId, messageId, kind }: { sessionId: string; messageId: string; kind: MenuKind }) {
  const promptId = precedingUserMessageId(useChatNavStore.getState().bySession[sessionId]?.index ?? [], messageId)
  if (!promptId) return null
  return (
    <>
      {menuSeparator(kind)}
      {actionMenuItem('transcript.scroll-to-prompt', { kind, onSelect: () => void jumpToMessage(sessionId, promptId) })}
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

const REVEAL_CLASS =
  'text-muted-foreground opacity-0 transition-opacity motion-reduce:transition-none focus-visible:opacity-100 group-focus-within/transcript-menu:opacity-100 group-hover/transcript-menu:opacity-100 group-data-[state=open]/transcript-menu:opacity-100'

// A finished message's context menu plus the ghost Copy and More actions buttons in a row whose
// height is reserved while streaming too, so the transcript never jumps when a reply finishes. The
// buttons mount on first pointer or focus entry; until then one native placeholder is the Tab stop
// (a bubble cannot take focus), and it hands focus to the real Copy button once that mounts (#471).
export function MessageMenu({ id, text, streaming = false, sessionId, align = 'start', children }: MessageMenuProps) {
  const canCopy = !streaming && text.trim() !== ''
  const [armed, setArmed] = React.useState(false)
  const focusOnArmRef = React.useRef(false)
  const rowRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (armed && focusOnArmRef.current) {
      focusOnArmRef.current = false
      rowRef.current?.querySelector('button')?.focus()
    }
  }, [armed])

  const items = (kind: MenuKind) => (
    <>
      {actionMenuItem('transcript.copy-message', { kind, onSelect: () => void copyLinkText(text, 'Message copied', NOTHING) })}
      {actionMenuItem('transcript.copy-message-plain', { kind, onSelect: () => void copyLinkText(markdownToPlainText(text), 'Message copied as plain text', NOTHING) })}
      {sessionId ? <ScrollToPromptItem sessionId={sessionId} messageId={id} kind={kind} /> : null}
    </>
  )

  return (
    <TranscriptMenu disabled={streaming} items={items} onArm={() => setArmed(true)}>
      {children}
      <div ref={rowRef} className={cn('mt-1 flex h-6 items-center gap-1', align === 'end' ? 'justify-end pr-10' : 'justify-start')}>
        {canCopy &&
          (armed ? (
            <>
              <CopyButton getText={() => text} label="Copy message" announcement="Message copied" className={REVEAL_CLASS} />
              <TranscriptKebab items={items} className={REVEAL_CLASS} />
            </>
          ) : (
            <button
              type="button"
              aria-label="Copy message"
              className="size-6 shrink-0 rounded-md opacity-0 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
              onFocus={() => {
                focusOnArmRef.current = true
                setArmed(true)
              }}
            />
          ))}
      </div>
    </TranscriptMenu>
  )
}