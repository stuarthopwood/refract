// The one agent of a single-agent Stage, shown inline on the Stage header so a one-child tree needs no expanding (#1927, FR-147).
import { Badge } from '@/components/ui/badge'
import { SUBAGENT_STATUS_LABEL, SubagentStatusGlyph } from '../subagentStatus'
import type { SubAgentItem } from '../viewModel/types'

export type ChipAgent = Pick<SubAgentItem, 'name' | 'role' | 'status'>

/** The full name, role and status for the tooltip, since the chip truncates. */
export function agentChipTitle(agent: ChipAgent): string {
  return [agent.name, agent.role, SUBAGENT_STATUS_LABEL[agent.status]].filter(Boolean).join(' \u00b7 ')
}

// 40% cap: the Stage title truncates first, the chip only past this width. The glyph carries status, so it is never colour alone.
export function AgentChip({ agent }: { agent: ChipAgent }) {
  return (
    <Badge variant="outline" className="max-w-[40%]" title={agentChipTitle(agent)} data-agent-chip>
      <SubagentStatusGlyph status={agent.status} />
      <span className="min-w-0 truncate">{agent.name}</span>
      {agent.role && <span className="min-w-0 truncate text-muted-foreground">{agent.role}</span>}
    </Badge>
  )
}
