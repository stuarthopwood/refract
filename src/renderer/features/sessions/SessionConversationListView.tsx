import { ChevronRightIcon, PlusIcon } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/IconButton'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/components/ui/composerFocus'
import { formatByteSize } from '@/lib/formatBytes'
import { cn } from '@/lib/utils'
import type { ConversationInfo } from '../../../shared/model'
import { CompactConversationRow } from '../chat/ConversationRow'
import { conversationTitle } from '../chat/conversationDelete'
import { conversationGroupId } from './conversationTreeFocus'

/** The newest Conversations shown before "Show all (N)". */
export const CONVERSATION_CAP = 5

const ENTRY_CLASS =
  'pl-[calc(var(--tree-indent,0px)+2.5rem)] pr-2 focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-[-2px] focus-visible:outline-ring'
const ACTION_CLASS = 'h-7 min-w-0 flex-1 justify-start gap-2 rounded-none px-2 text-xs text-muted-foreground aria-disabled:opacity-50'

export function conversationReasonId(sessionId: string): string {
  return `${conversationGroupId(sessionId)}-reason`
}

export function conversationCountLabel(count: number): string {
  return count === 1 ? '1 conversation' : `${count} conversations`
}

/** The entries a collapsed-to-the-cap list shows, and how many are held back. */
export function capConversations<T>(conversations: readonly T[], showAll: boolean): { visible: readonly T[]; hidden: number } {
  if (showAll || conversations.length <= CONVERSATION_CAP) return { visible: conversations, hidden: 0 }
  return { visible: conversations.slice(0, CONVERSATION_CAP), hidden: conversations.length - CONVERSATION_CAP }
}

function ActionEntry({ onClick, disabled, children }: { onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <li role="treeitem" tabIndex={-1} data-conversation-entry="" className={cn('flex min-w-0 items-center', ENTRY_CLASS)}>
      <Button
        variant="ghost"
        tabIndex={-1}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onClick()
        }}
        className={ACTION_CLASS}
      >
        {children}
      </Button>
    </li>
  )
}

export interface SessionConversationListViewProps {
  sessionId: string
  sessionName: string
  open: boolean
  /** Null until the first read finishes, so the badge appears with the data. */
  total: number | null
  loading: boolean
  error: string | null
  /** Newest first. */
  conversations: readonly ConversationInfo[]
  showAll: boolean
  /** Why no entry can be opened right now, or null when they can. */
  blockedReason: string | null
  deleting: ReadonlySet<string>
  onToggle(): void
  onReload(): void
  onShowAll(): void
  onNew(): void
  onOpen(file: string): void
  onDelete(conversation: ConversationInfo): void
  onKeyDown(event: KeyboardEvent<HTMLUListElement>): void
}

/** The disclosure under a Session row and, while open, its nested list of Conversations. */
export function SessionConversationListView(props: SessionConversationListViewProps) {
  const { sessionId, sessionName, open, total, loading, error, conversations, showAll, blockedReason, deleting } = props
  const groupId = conversationGroupId(sessionId)
  const reasonId = conversationReasonId(sessionId)
  const { visible, hidden } = capConversations(conversations, showAll)
  return (
    <div data-testid="session-conversations" className="w-full">
      <div className="flex h-6 items-center gap-1 pl-[calc(var(--tree-indent,0px)+1.5rem)] pr-2 text-xs text-muted-foreground">
        <IconButton
          size="icon-xs"
          label={`Show conversations for ${sessionName}`}
          tabIndex={-1}
          aria-expanded={open}
          aria-controls={open ? groupId : undefined}
          onClick={props.onToggle}
          className={cn('text-muted-foreground hover:bg-sidebar-border hover:text-foreground dark:hover:bg-sidebar-border', COMPOSER_BUTTON_FOCUS_CLASS)}
        >
          <ChevronRightIcon aria-hidden className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        </IconButton>
        <span aria-hidden>Conversations</span>
        {total !== null && (
          <Badge variant="secondary" data-testid="session-conversation-count">
            <span aria-hidden>{total}</span>
            <span className="sr-only">{conversationCountLabel(total)}</span>
          </Badge>
        )}
      </div>
      {open && (
        <>
          {loading && (
            <p role="status" className="pl-[calc(var(--tree-indent,0px)+2.5rem)] pr-2 text-xs text-muted-foreground">
              Loading conversations…
            </p>
          )}
          {blockedReason && (
            <p id={reasonId} className="pl-[calc(var(--tree-indent,0px)+2.5rem)] pr-2 text-xs text-muted-foreground">
              {blockedReason}
            </p>
          )}
          <ul
            role="group"
            id={groupId}
            aria-label={`Conversations of ${sessionName}`}
            onKeyDown={props.onKeyDown}
            className="flex flex-col gap-0"
          >
            <ActionEntry onClick={props.onNew} disabled={blockedReason !== null}>
              <PlusIcon aria-hidden className="size-4" />
              New conversation
            </ActionEntry>
            {visible.map((conversation) => (
              <CompactConversationRow
                key={conversation.file}
                conversation={conversation}
                title={conversationTitle(conversation)}
                size={formatByteSize(conversation.sizeBytes)}
                openDisabled={blockedReason !== null || conversation.isCurrent}
                deleting={deleting.has(conversation.file)}
                onOpen={props.onOpen}
                onDelete={props.onDelete}
                role="treeitem"
                tabIndex={-1}
                buttonTabIndex={-1}
                describedBy={reasonId}
                className={ENTRY_CLASS}
              />
            ))}
            {hidden > 0 && <ActionEntry onClick={props.onShowAll}>Show all ({conversations.length})</ActionEntry>}
            {error && (
              <ActionEntry onClick={props.onReload}>
                <span role="alert">Could not load conversations: {error}. Retry</span>
              </ActionEntry>
            )}
          </ul>
        </>
      )}
    </div>
  )
}
