import * as React from 'react'
import { MessageSquareIcon } from 'lucide-react'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/ui/message'
import type { TranscriptItem } from '../../../shared/model'
import { UserAvatar } from '@/components/UserAvatar'
import { Markdown } from './Markdown'
import { FileAttachmentChip } from './FileAttachmentChip'
import { MessageImageGrid } from '@/components/MessageImageGrid'
import { MessageMenu } from './MessageMenu'
import { SessionSourceLine } from './SessionSourceLine'

export type UserItem = Extract<TranscriptItem, { kind: 'user' }>

interface UserMessageRowProps {
  item: UserItem
  userName: string | undefined
  /** #505: shared photo data URL; initials when absent. */
  userAvatarUrl?: string
  /** True when a `TimeGapDivider` directly above already shows the time. */
  hideTime?: boolean
}

// `numeric: 'auto'` yields the localised word ("yesterday") instead of "1 day ago".
const RELATIVE_DAY_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

// Day diff uses local midnights, not 24h multiples, so DST can't misclassify yesterday/today.
function formatMessageTime(date: Date): string {
  const now = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.round((startOfToday - startOfThatDay) / 86_400_000)
  if (dayDiff === 0) return time
  if (dayDiff === 1) {
    const word = RELATIVE_DAY_FORMAT.format(-1, 'day')
    return `${word[0]!.toLocaleUpperCase()}${word.slice(1)} ${time}`
  }
  if (date.getFullYear() === now.getFullYear()) return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${time}`
}

// Hidden for `at === 0` (never timestamped) and for out-of-range values: an Invalid Date makes
// `toISOString()` throw mid-render and kill the pane.
function UserMessageTime({ at, hide }: { at: number; hide: boolean | undefined }) {
  if (hide) return null
  if (at === 0) return null
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  const label = formatMessageTime(date)
  return (
    <div className="mb-1 flex justify-end text-xs text-muted-foreground">
      <time dateTime={date.toISOString()}>{label}</time>
    </div>
  )
}

/** Right-aligned user bubble; the timestamp is a sibling above the whole `Message`. */
export function UserMessageRow({ item, userName, userAvatarUrl, hideTime }: UserMessageRowProps) {
  const source = item.source
  // A Session-sent turn is authored by that Session, not the user: no user avatar or name.
  const author = source ? source.name : (userName ?? 'You')
  const sourceLineId = React.useId()
  return (
    <>
      <UserMessageTime at={item.at} hide={hideTime} />
      {source && <SessionSourceLine source={source} id={sourceLineId} />}
      <MessageMenu id={item.id} text={item.text} align="end">
      <Message align="end">
        <MessageAvatar aria-hidden>
          {source ? (
            <UserAvatar name={source.name} fallback={<MessageSquareIcon aria-hidden className="size-4" />} />
          ) : (
            <UserAvatar name={author} src={userAvatarUrl} />
          )}
        </MessageAvatar>
        <MessageContent
          {...(source ? { role: 'group', 'aria-labelledby': sourceLineId } : {})}
          className="w-fit max-w-[85%] rounded-lg bg-chat-user-bubble-bg px-4 py-2 outline-1 -outline-offset-1 outline-chat-user-bubble-border forced-colors:outline-2"
        >
          <MessageHeader className="px-0 text-muted-foreground">{author}</MessageHeader>
          {/* Chips instead of the raw inlined file text, which could flood the transcript (#926). */}
          {item.fileAttachments && item.fileAttachments.length > 0 && (
            <div role="group" aria-label="Attached files" className="mb-1 flex flex-wrap items-center gap-2">
              {item.fileAttachments.map((file) => (
                <FileAttachmentChip key={file.id} name={file.name} byteLength={file.byteLength} isDirectory={file.isDirectory} sentAs={file.sentAs} wrap className="max-w-full" />
              ))}
            </div>
          )}
          {item.images && item.images.length > 0 && <MessageImageGrid images={item.images} className="mb-2" />}
          {item.text.trim() !== '' && <Markdown id={item.id} text={item.text} variant="chat" className="text-chat-user-bubble-fg" />}
          {/* An image-only message whose images are missing still says so (#744). */}
          {item.text.trim() === '' && !item.fileAttachments?.length && !item.images?.length && <p className="text-sm text-muted-foreground">Image attached</p>}
        </MessageContent>
      </Message>
      </MessageMenu>
    </>
  )
}
