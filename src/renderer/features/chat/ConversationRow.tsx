import { memo, useMemo, type AriaRole } from 'react'
import { Trash2Icon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { IconButton } from '@/components/IconButton'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatByteSize } from '@/lib/formatBytes'
import { cn } from '@/lib/utils'
import type { ConversationInfo } from '../../../shared/model'
import { conversationTitle } from './conversationDelete'

interface ConversationRowProps {
  conversation: ConversationInfo
  /** Opening is blocked (the agent is working, a switch is running, or this is the current one). */
  openDisabled: boolean
  deleting: boolean
  /** Stable callbacks taking the row's own data, so a list update only re-renders the rows that changed. */
  onOpen(file: string): void
  onDelete(conversation: ConversationInfo): void
}

export const ConversationRow = memo(function ConversationRow({ conversation, openDisabled, deleting, onOpen, onDelete }: ConversationRowProps) {
  const title = conversationTitle(conversation)
  const created = useMemo(() => new Date(conversation.createdAt).toLocaleString(), [conversation.createdAt])
  const size = formatByteSize(conversation.sizeBytes)
  const blocked = openDisabled || deleting
  return (
    <li data-conversation-file={conversation.file} className="flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild aria-describedby={undefined}>
          <Button
            variant="ghost"
            aria-disabled={blocked}
            aria-current={conversation.isCurrent}
            onClick={() => {
              if (!blocked) onOpen(conversation.file)
            }}
            data-choice-item
            className="h-auto min-w-0 flex-1 flex-col items-stretch justify-start gap-1 rounded-none border-0 border-l-2 border-transparent px-2 py-2 text-left whitespace-normal focus-visible:border-ring aria-disabled:opacity-50 aria-[current=true]:border-l-active-indicator aria-[current=true]:bg-muted aria-[current=true]:opacity-100"
          >
            <span className="flex items-center gap-2 text-sm">
              <span className="min-w-0 truncate">{title}</span>
              {conversation.isCurrent && <Badge variant="secondary">Current</Badge>}
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {created} · {deleting ? 'Deleting…' : size}
            </span>
            {conversation.preview && <span className="truncate text-xs text-muted-foreground">{conversation.preview}</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={22}
          collisionPadding={8}
          className="flex-col items-start [overflow-wrap:anywhere] max-w-[min(20rem,var(--radix-tooltip-content-available-width))]"
        >
          <p>{title}</p>
          <p className="text-muted-foreground">
            {created} · {size}
          </p>
          {conversation.preview && <p className="text-muted-foreground">{conversation.preview}</p>}
        </TooltipContent>
      </Tooltip>
      <IconButton label={`Delete ${title}, ${created}`} aria-disabled={deleting} className="aria-disabled:opacity-50" onClick={() => !deleting && onDelete(conversation)}>
        <Trash2Icon />
      </IconButton>
    </li>
  )
})

interface CompactConversationRowProps {
  conversation: ConversationInfo
  /** Already formatted by the caller, so a list update re-renders only the rows whose text changed. */
  title: string
  size: string
  openDisabled: boolean
  deleting: boolean
  onOpen(file: string): void
  onDelete(conversation: ConversationInfo): void
  /** Lets a tree make the row a `treeitem` and manage its roving focus. */
  role?: AriaRole
  tabIndex?: number
  /** Marks the row as a keyboard-navigable entry of the nested list, with or without a tree role. */
  entry?: boolean
  /** A tree reaches the row by arrow keys, so its buttons stay out of the Tab order. */
  buttonTabIndex?: number
  /** The id of the element that says why opening is blocked. */
  describedBy?: string
  className?: string
}

/** One-line variant for the Session row's nested list: title, current marker, size and a delete button. */
export const CompactConversationRow = memo(function CompactConversationRow({
  conversation,
  title,
  size,
  openDisabled,
  deleting,
  onOpen,
  onDelete,
  role,
  tabIndex,
  entry,
  buttonTabIndex,
  describedBy,
  className
}: CompactConversationRowProps) {
  const blocked = openDisabled || deleting
  return (
    <li
      data-conversation-file={conversation.file}
      role={role}
      data-conversation-entry={entry ? '' : undefined}
      tabIndex={tabIndex}
      aria-label={role === 'treeitem' ? `${title}${conversation.isCurrent ? ', current' : ''}, ${size}` : undefined}
      className={cn('flex min-w-0 items-center gap-1', className)}
    >
      <Button
        variant="ghost"
        tabIndex={buttonTabIndex}
        aria-describedby={blocked ? describedBy : undefined}
        aria-disabled={blocked}
        aria-current={conversation.isCurrent}
        onClick={() => {
          if (!blocked) onOpen(conversation.file)
        }}
        data-choice-item
        className="h-7 min-w-0 flex-1 justify-start gap-2 rounded-none border-0 border-l-2 border-transparent px-2 text-left text-xs focus-visible:border-ring aria-disabled:opacity-50 aria-[current=true]:border-l-active-indicator aria-[current=true]:bg-muted aria-[current=true]:opacity-100"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {conversation.isCurrent && <Badge variant="secondary">Current</Badge>}
        <span className="shrink-0 text-muted-foreground">{deleting ? 'Deleting…' : size}</span>
      </Button>
      <IconButton
        label={`Delete ${title}`}
        tabIndex={buttonTabIndex}
        aria-disabled={deleting}
        className="aria-disabled:opacity-50"
        onClick={() => !deleting && onDelete(conversation)}
      >
        <Trash2Icon />
      </IconButton>
    </li>
  )
})
