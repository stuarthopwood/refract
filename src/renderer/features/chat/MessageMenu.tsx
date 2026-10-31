import * as React from 'react'
import { CopyIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
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

// Distinguishes one row's kebab from the next by the message's opening words.
function messageSnippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 32 ? `${flat.slice(0, 32).trimEnd()}…` : flat
}

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
  React.useLayoutEffect(() => {
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
              <TranscriptKebab items={items} align={align} label={`More actions, ${messageSnippet(text)}`} className={REVEAL_CLASS} />
            </>
          ) : (
            <IconButton
              label="Copy message"
              size="icon-xs"
              className={cn('shrink-0', REVEAL_CLASS)}
              onClick={() => void copyLinkText(text, 'Message copied', NOTHING)}
              onFocus={() => {
                focusOnArmRef.current = true
                setArmed(true)
              }}
            >
              <CopyIcon aria-hidden />
            </IconButton>
          ))}
      </div>
    </TranscriptMenu>
  )
}