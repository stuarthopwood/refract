import { memo, useMemo } from 'react'
import { Trash2Icon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { IconButton } from '@/components/IconButton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatByteSize } from '@/lib/formatBytes'
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
          <button
            type="button"
            aria-disabled={blocked}
            aria-current={conversation.isCurrent}
            onClick={() => {
              if (!blocked) onOpen(conversation.file)
            }}
            data-choice-item
            className="flex min-w-0 flex-1 flex-col gap-1 border-l-2 border-transparent px-2 py-2 text-left outline-none focus-visible:outline-hidden hover:bg-muted focus-visible:border-ring focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-[current=true]:border-l-active-indicator aria-[current=true]:bg-muted aria-[current=true]:opacity-100"
          >
            <span className="flex items-center gap-2 text-sm">
              <span className="min-w-0 truncate">{title}</span>
              {conversation.isCurrent && <Badge variant="secondary">Current</Badge>}
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {created} · {deleting ? 'Deleting…' : size}
            </span>
            {conversation.preview && <span className="truncate text-xs text-muted-foreground">{conversation.preview}</span>}
          </button>
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
      <IconButton label={`Delete ${title}`} aria-disabled={deleting} className="aria-disabled:opacity-50" onClick={() => !deleting && onDelete(conversation)}>
        <Trash2Icon />
      </IconButton>
    </li>
  )
})
