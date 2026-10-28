import * as React from 'react'
import { MessageSquareReplyIcon, MessageSquareShareIcon, MessagesSquareIcon, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine } from './CollapsedLine'
import { ToolCallDialog } from './ToolCallDialog'
import { StatusIcon } from './toolStatus'
import { agentDisplayName, agentMessageDirection, agentSteerTarget, MAIN_AGENT_LABEL, type AgentMessageDirection } from './agentMessageDirection'

type AgentMessageItem = Extract<TranscriptItem, { kind: 'agent-message' }>
type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// Issue #838: one bubble glyph per direction, all in the one `--agent-message` colour (the
// glyph carries direction, the colour carries "agents talking"). Decorative: the label and the
// sr-only prefix state the direction in text.
const DIRECTION_GLYPH: Record<AgentMessageDirection, LucideIcon> = {
  'to-main': MessageSquareReplyIcon,
  'from-main': MessageSquareShareIcon,
  peer: MessagesSquareIcon
}

const AGENT_MESSAGE_LABEL_CLASS = 'text-agent-message'

function DirectionGlyph({ direction, broadcast }: { direction: AgentMessageDirection; broadcast?: boolean }) {
  const Icon = broadcast ? MessagesSquareIcon : DIRECTION_GLYPH[direction]
  return <Icon aria-hidden data-agent-message-direction={direction} className="size-4 shrink-0 text-agent-message" />
}

// The visible "<sender> to <recipient>" plus an sr-only "Agent message from X to Y" in its
// place, so a screen reader hears the category once, never the pair twice.
function AgentLabel({ from, to, suffix }: { from: string; to: string; suffix?: string }) {
  return (
    <>
      <span className="sr-only">{`Agent message from ${from} to ${to}${suffix ?? ''}`}</span>
      <span aria-hidden>{`${from} to ${to}${suffix ?? ''}`}</span>
    </>
  )
}

// One collapsed line per IRC-style message between a subagent and the main agent, or between
// subagents (T079, FR-048, issue #838): a direction glyph, "<sender> to <recipient>" in the
// agent-message colour, and a muted one-line preview, expanding to the full message as plain
// text. Never grouped (`groupToolItems` only ever sees `tool` items) and never hidden.
export function AgentMessageRow({ item }: { item: AgentMessageItem }) {
  const direction = agentMessageDirection(item)
  return (
    <CollapsedLine
      icon={<DirectionGlyph direction={direction} />}
      label={<AgentLabel from={agentDisplayName(item.from)} to={agentDisplayName(item.to)} />}
      labelClassName={AGENT_MESSAGE_LABEL_CLASS}
      summary={item.text}
    >
      <div className="whitespace-pre-wrap text-sm">{item.text}</div>
    </CollapsedLine>
  )
}

// Issue #838: the main agent steering a subagent (`write agent://<id>`) reads as an
// agent-to-agent line, not a generic tool row; still a tool call underneath, so expanding it
// keeps "View full call". State wins over category colour: running, failed, interrupted and
// stopped show their status glyph, and a failed write reads "failed" in the error colour.
export function AgentSteerRow({ item }: { item: ToolItem }) {
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const target = agentSteerTarget(item) ?? item.target
  const broadcast = target === 'all'
  const to = broadcast ? 'all agents' : target
  const content = item.write?.content ?? ''
  const failed = item.status === 'error'
  return (
    <CollapsedLine
      icon={item.status === 'done' ? <DirectionGlyph direction="from-main" broadcast={broadcast} /> : <StatusIcon status={item.status} />}
      label={<AgentLabel from={MAIN_AGENT_LABEL} to={to} suffix={failed ? ' failed' : undefined} />}
      labelClassName={cn(failed ? 'text-severity-error' : item.status === 'done' ? 'text-agent-message' : undefined)}
      summary={content.split('\n')[0]}
    >
      <div className="whitespace-pre-wrap text-sm">{content}</div>
      <ToolCallDialog item={item} open={dialogOpen} onOpenChange={setDialogOpen} />
    </CollapsedLine>
  )
}
