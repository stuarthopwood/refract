import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'
import { cn } from '@/lib/utils'
import { FileChipList } from '@/components/FileChip'
import { openHostedPanel } from '../right-pane/hosted-panel-actions'
import { SUBAGENT_STATUS_LABEL, SubagentStatusGlyph } from '../subagents/subagentStatus'
import { plainSummary } from './stageMeta'
import { ResultMarkdown } from '../subagents/card/ResultMarkdown'
import { FILES_TOUCHED_LABEL, type SubAgentItem } from '../subagents/viewModel'
import { CausalBadge, causalBadgeText } from '../subagents/card/CausalBadge'
import { Heartbeat, heartbeatText } from '../subagents/card/Heartbeat'
import { SubStepList } from '../subagents/card/SubStepList'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

interface SubagentCardBodyProps {
  agent: SubAgentItem
  /** A single-agent Stage's body (#2318, FR-176): no panel, name, status or outcome (the Stage row carries them), only a left guide line. */
  flat?: boolean
  /** False draws the files overflow as text, for a host that is itself one control, so no button nests in it (FR-178). */
  interactive?: boolean
  /** The flat body's first line when the agent has no role, so a clickable body never collapses to nothing. */
  fallbackLabel?: string
}

// The card body (#1928): name, role, what it did, provenance and files, then a live heartbeat and
// sub-steps while it runs. Every optional part renders nothing when absent, so no empty row or gap is
// left behind. The chat sub-card button and the panel's tree row both draw it, so it needs no transcript item (#1930).
export function SubagentCardBody({ agent, flat = false, interactive = true, fallbackLabel }: SubagentCardBodyProps) {
  const { status, duration, name, role, whatItDid, triggeredBy, filesTouched, liveDetail, subSteps } = agent
  const running = status === 'running'
  const hasProvenanceRow = causalBadgeText(triggeredBy) != null || (filesTouched?.length ?? 0) > 0
  const hasLive = running && (heartbeatText(liveDetail) != null || (subSteps?.length ?? 0) > 0)
  const hasRole = role != null && role !== ''
  const flatLead = hasRole ? role : fallbackLabel
  return (
    <div className={cn('min-w-0 space-y-2', flat ? 'min-h-5 border-l-2 border-divider py-1 pl-4' : 'rounded-lg border border-divider bg-surface-1 p-2 group-hover/subcard:bg-surface-hover')}>
      {flat ? (
        flatLead && <div className="min-w-0 truncate text-xs text-muted-foreground">{flatLead}</div>
      ) : (
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="flex shrink-0 items-center gap-1">
            <SubagentStatusGlyph status={status} />
            {status !== 'finished' && <span aria-hidden="true" className="text-muted-foreground">{SUBAGENT_STATUS_LABEL[status]}</span>}
          </span>
          <span className="min-w-0 truncate font-mono text-sm font-semibold text-card-foreground">{name}</span>
          {hasRole && <span className="min-w-0 truncate text-muted-foreground">{role}</span>}
          {!running && duration != null && <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{duration}</span>}
        </div>
      )}
      {!flat && whatItDid != null && whatItDid !== '' && (
        <div title={plainSummary(whatItDid)} className="text-sm text-card-foreground">
          <ResultMarkdown text={whatItDid} lines={2} />
        </div>
      )}
      {hasProvenanceRow && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <CausalBadge triggeredBy={triggeredBy} />
          <FileChipList files={filesTouched} label={FILES_TOUCHED_LABEL} interactive={interactive} />
        </div>
      )}
      {hasLive && (
        <div className="space-y-2 border-t border-divider pt-2">
          <Heartbeat liveDetail={liveDetail} />
          <SubStepList steps={subSteps} />
        </div>
      )}
    </div>
  )
}

/** The sub-card's accessible name (FR-178): the agent, its status, then what the button does. */
export function subagentCardButtonName(agent: Pick<SubAgentItem, 'name' | 'status'>): string {
  return `${agent.name}, ${SUBAGENT_STATUS_LABEL[agent.status]}, open in Subagents panel`
}

/** Opens the agent's inspector in the Subagents panel; the button passes itself as the opener so focus can return to it. */
export function openSubagentInPanel(sessionId: string, match: { id: string; toolCallId: string; specIndex: number }, opener: HTMLElement | null): void {
  openHostedPanel('subagents', sessionId, {
    selectSubagentId: match.id,
    selectSubagentKey: `${match.toolCallId}:${match.specIndex}`,
    opener
  })
}

interface SubagentCardButtonProps {
  item: SubagentItem
  agent: SubAgentItem
  sessionId: string | null
  /** A single-agent Stage expands flat with a left guide line (FR-176). */
  flat?: boolean
  /** The flat body's first line when the agent has no role and its name differs from the Stage title. */
  fallbackLabel?: string
}

// One sub-card is one native <button> covering the whole card (FR-178): Tab, Enter, Space and click open the agent in the
// Subagents panel. The body inside is non-interactive so no control nests in the button. With no live match to open, it is a plain block.
export function SubagentCardButton({ item, agent, sessionId, flat = false, fallbackLabel }: SubagentCardButtonProps) {
  const subagents = useReadoutStore((s) => (sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).subagents : EMPTY_READOUT_ENTRY.subagents))
  const match = subagents.find((s) => s.toolCallId === item.toolCallId && s.specIndex === item.specIndex)
  const body = <SubagentCardBody agent={agent} flat={flat} interactive={false} fallbackLabel={fallbackLabel} />
  if (!match || !sessionId) return <div className="min-w-0">{body}</div>
  return (
    <button
      type="button"
      aria-label={subagentCardButtonName(agent)}
      className="group/subcard block w-full min-w-0 cursor-pointer rounded-lg text-left focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={(event) => openSubagentInPanel(sessionId, match, event.currentTarget)}
    >
      {body}
    </button>
  )
}
