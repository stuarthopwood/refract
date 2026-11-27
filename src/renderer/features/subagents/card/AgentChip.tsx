// The one agent of a single-agent Stage, named as quiet monospace text on the Stage header: no border, no repeated tick (#2318, FR-176).
// It takes the accent text colour while the agent runs.
import { cn } from '@/lib/utils'
import { SUBAGENT_STATUS_LABEL } from '../subagentStatus'
import type { SubAgentItem } from '../viewModel/types'

export type ChipAgent = Pick<SubAgentItem, 'name' | 'role' | 'status'>

/** The full name, role and status for the tooltip, since the text truncates. */
export function agentChipTitle(agent: ChipAgent): string {
  return [agent.name, agent.role, SUBAGENT_STATUS_LABEL[agent.status]].filter(Boolean).join(' \u00b7 ')
}

// 40% cap: the Stage title truncates first. The Stage's own tick carries the status, so none is repeated here.
export function AgentChip({ agent }: { agent: ChipAgent }) {
  return (
    <span className={cn('max-w-[40%] shrink-0 truncate font-code text-micro', agent.status === 'running' ? 'text-accent-text' : 'text-muted-foreground')} title={agentChipTitle(agent)} data-agent-chip>
      {agent.name}
    </span>
  )
}
