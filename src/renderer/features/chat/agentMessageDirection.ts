import type { TranscriptItem } from '../../../shared/model'

type AgentMessageItem = Extract<TranscriptItem, { kind: 'agent-message' }>
type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// Issue #838: who an agent-to-agent line is going between. The glyph shows the direction; the
// label text states it too, so the glyph is never the only cue.
export type AgentMessageDirection = 'to-main' | 'from-main' | 'peer'

export const MAIN_AGENT_LABEL = 'Main agent'

// OMP writes the parent as "Main" in `from`; the Rust builder defaults a missing `to` to "main
// agent". Both read as the one consistent label.
export function isMainAgentName(name: string): boolean {
  return /^main( agent)?$/i.test(name.trim())
}

export function agentDisplayName(name: string): string {
  return isMainAgentName(name) ? MAIN_AGENT_LABEL : name
}

// Rust passes OMP's own `fromParent` through when it has it; the name heuristic is the fallback.
export function agentMessageDirection(item: Pick<AgentMessageItem, 'from' | 'to' | 'fromParent'>): AgentMessageDirection {
  if (item.fromParent === true || isMainAgentName(item.from)) return 'from-main'
  if (isMainAgentName(item.to)) return 'to-main'
  return 'peer'
}

// The main agent steering a subagent is a `write agent://<id>` tool call. Returns the target id
// (or `all` for a broadcast) when the call should render as an agent-to-agent line, else
// `undefined` (an empty message or a non-agent path keeps the plain tool row).
export function agentSteerTarget(item: ToolItem): string | undefined {
  if (item.tool !== 'write' || !item.write) return undefined
  const match = /^agent:\/\/([A-Za-z0-9_.:-]+)\/?$/.exec(item.write.path.trim())
  if (!match || item.write.content.trim() === '') return undefined
  return match[1]
}
