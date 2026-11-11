import * as React from 'react'
import { Message, MessageContent } from '@/components/ui/message'
import { type PendingRequest, type TranscriptItem } from '../../../shared/model'
import { Markdown } from './Markdown'
import { AgentMessageRow, AgentSteerRow } from './AgentMessageRow'
import { AdvisoryRow, AdvisoryRunRow } from './AdvisoryRow'
import { isAdvisoryRun, type AdvisoryGroupedTranscriptItem } from './groupAdvisoryItems'
import { isAgentSteerGroup, isToolGroup, isThoughtRun } from './groupToolItems'
import { ThoughtRunRow } from './ThoughtRunRow'
import { MidTurnProseRow } from './MidTurnProseRow'
import { isMidTurnProse } from './groupMidTurnProse'
import { isStageGroup } from './groupSubagentStages'
import { StageGroupRow } from './SubagentChainRow'
import { ToolGroupRow } from './ToolRow'
import { AskToolRow, RequestItemRow } from './AskFormRows'
import { UserMessageRow } from './UserMessageRow'
import { MessageMenu } from './MessageMenu'
import { NoticeRow } from './NoticeRow'
import { COMMAND_OUTPUT_NOTICE_PREFIX } from '../../../shared/commandOutputNotice'
import { TurnErrorRow } from './TurnErrorRow'
import { SkillPromptRow } from './SkillPromptRow'

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// A stable empty list so a Session with no pending requests never hands every row a fresh `[]`.
export const NO_PENDING: PendingRequest[] = []

export interface TranscriptRowProps {
  item: AdvisoryGroupedTranscriptItem
  sessionId: string | null
  pending: PendingRequest[]
  userName: string | undefined; hideTime?: boolean // #555 amendment: hides a user row's own time under a directly-above TimeGapDivider (see UserMessageRowProps)
  /** #505: the user's GitHub photo (data URL), shared by every row; absent shows initials. */
  userAvatarUrl?: string
  /** A `request` row's own matching `ask` tool item (resolved questions only). */
  resolvedAsk?: ToolItem
  /** An `ask` tool row's own request id. */
  askRequestId?: string
  /** #1210: set on the turn's one newest running row only (newestRunningRow.ts). */
  shimmer?: boolean
  /** Both reuse EXISTING Transcript mechanisms (gate round 2/3): reveal -> suppressLogAnnouncements; queued -> revealedAnnouncement. */
  onAdvisoryReveal: () => void
  onQueuedAnnounce: (text: string) => void
}

// Grouping rebuilds every group object on each patch, so a group is equal when its own fields are
// equal, recursing only into nested groups; plain transcript items keep their identity.
function isGroup(value: unknown): value is { kind: string; items: unknown[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameValue(value, b[index]))
  if (isGroup(a) && isGroup(b)) return sameGroup(a, b)
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && Object.getPrototypeOf(a) === Object.prototype) {
    const keysA = Object.keys(a)
    return keysA.length === Object.keys(b).length && keysA.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  }
  return false
}

function sameGroup(a: object, b: object): boolean {
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

// A real transcript item that changed is a new object (the store replaces, never mutates), so
// identity is the right test for it; only the freshly rebuilt group wrappers need a structural test.
function areRowPropsEqual(prev: TranscriptRowProps, next: TranscriptRowProps): boolean {
  return (
    prev.sessionId === next.sessionId &&
    prev.pending === next.pending &&
    prev.userName === next.userName &&
    prev.userAvatarUrl === next.userAvatarUrl &&
    prev.hideTime === next.hideTime &&
    prev.resolvedAsk === next.resolvedAsk &&
    prev.askRequestId === next.askRequestId &&
    prev.shimmer === next.shimmer &&
    prev.onAdvisoryReveal === next.onAdvisoryReveal &&
    prev.onQueuedAnnounce === next.onQueuedAnnounce &&
    (prev.item === next.item || (isGroup(prev.item) && isGroup(next.item) && sameGroup(prev.item, next.item)))
  )
}

// Renders one grouped transcript row per its kind (data-model.md `TranscriptItem`,
// docs/DESIGN.md "Chat"). A `request` item looks itself up in the pending-requests store: still
// pending -> RequestCard; an answered/cancelled question is superseded by the matching `ask`
// tool item once it resolves (T072/T073); a decided approval keeps its one-line summary.
function TranscriptRowImpl({ item, sessionId, pending, userName, userAvatarUrl, resolvedAsk, askRequestId, hideTime, shimmer, onAdvisoryReveal, onQueuedAnnounce }: TranscriptRowProps) {
  if (isAdvisoryRun(item)) return <AdvisoryRunRow group={item} sessionId={sessionId ?? undefined} onReveal={onAdvisoryReveal} onQueuedAnnounce={onQueuedAnnounce} />
  if (isStageGroup(item)) return <StageGroupRow group={item} sessionId={sessionId} shimmer={shimmer} />
  if (isToolGroup(item)) return isAgentSteerGroup(item) ? <AgentSteerRow item={item.items[0]!} /> : <ToolGroupRow group={item} shimmer={shimmer} />
  if (isThoughtRun(item)) return <ThoughtRunRow group={item} shimmer={shimmer} />
  if (isMidTurnProse(item)) return <MidTurnProseRow group={item} />

  switch (item.kind) {
    case 'user':
      // Rendering (including the per-message timestamp, issue #555) lives in `UserMessageRow` (split out to keep Transcript.tsx within its `check:file-size` baseline).
      return <UserMessageRow item={item} userName={userName} userAvatarUrl={userAvatarUrl} hideTime={hideTime} />

    case 'assistant-text':
      return (
        <MessageMenu id={item.id} text={item.text} streaming={item.streaming} sessionId={sessionId}>
          <Message>
            <MessageContent className="w-full">
              <Markdown id={item.id} text={item.text} streaming={item.streaming} variant="chat" className="text-chat-foreground" />
              {item.streaming && (
                <span aria-hidden className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-foreground/50 align-middle" />
              )}
            </MessageContent>
          </Message>
        </MessageMenu>
      )

    case 'thinking':
      // Defensive fallback for a non-empty `thinking` item that reaches here ungrouped (should
      // not normally occur: `groupThoughtItems` wraps every run, including a run of one, into a
      // `ThoughtRun` before this renders -- see `groupToolItems.ts`'s own comment for why every
      // consumer downstream must never switch React element type between a lone item and a run).
      // `!item.text` matches `groupThoughtItems`'s own "dropped from grouping" rule for an empty
      // thought (defensive; Rust never actually sends one).
      if (!item.text) return null
      return <ThoughtRunRow group={{ kind: 'thought-run', id: item.id, items: [item] }} />

    case 'tool':
      if (item.tool === 'ask') {
        return <AskToolRow item={item} sessionId={sessionId} userName={userName} userAvatarUrl={userAvatarUrl} askRequestId={askRequestId} />
      }
      // Defensive fallback for a non-ask `tool` item that reaches here ungrouped (should not
      // normally occur: `groupToolItems` wraps every run, including a run of one, in a
      // `ToolGroup` before this renders). Wrapped as a one-item group so this still renders
      // through the same `ToolGroupRow` component type as the grouped path above.
      return <ToolGroupRow group={{ kind: 'tool-group', id: item.id, tool: item.tool, items: [item] }} />

    case 'agent-message':
      return <AgentMessageRow item={item} />

    case 'advisory':
      return <AdvisoryRow item={item} sessionId={sessionId ?? undefined} onQueuedAnnounce={onQueuedAnnounce} />

    case 'request':
      return <RequestItemRow item={item} sessionId={sessionId} pending={pending} resolvedAsk={resolvedAsk} />

    case 'notice':
      return <NoticeRow level={item.level} text={item.text} commandOutput={item.id.startsWith(COMMAND_OUTPUT_NOTICE_PREFIX)} />

    case 'turn-error':
      return <TurnErrorRow item={item} sessionId={sessionId} />

    case 'skill-prompt':
      return <SkillPromptRow item={item} />

    default:
      return null
  }
}

export const TranscriptRow = React.memo(TranscriptRowImpl, areRowPropsEqual)
