import * as React from 'react'
import { ArrowRightIcon } from 'lucide-react'
import type { TranscriptItem } from '../../../shared/model'
import { CollapsedLine } from './CollapsedLine'

type AgentMessageItem = Extract<TranscriptItem, { kind: 'agent-message' }>

interface AgentMessageRowProps {
  item: AgentMessageItem
}

// One collapsed line per IRC-style message between a subagent and the main agent, or between
// subagents (T079, FR-048, docs/DESIGN.md "Chat"): a direction icon, "<sender> to <recipient>",
// and a one-line preview on the T080 baseline, expanding to the full message as plain text.
// Never grouped (`groupToolItems` only ever sees `tool` items) and never hidden.
export function AgentMessageRow({ item }: AgentMessageRowProps) {
  return (
    <CollapsedLine
      icon={<ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      label={`${item.from} to ${item.to}`}
      summary={item.text}
    >
      <div className="whitespace-pre-wrap text-sm">{item.text}</div>
    </CollapsedLine>
  )
}
