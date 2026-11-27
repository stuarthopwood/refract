// The panel's flat tree: one row per Stage, plus one per agent of every open Stage (FR-150). Pure so the keyboard model,
// the row order and the accessible names are tested without a DOM.
import { fileBasename } from '@/components/FileChip'
import { plainSummary } from '../chat/stageMeta'
import { stageAccessibleName, stageRowModel } from './card/stageRowModel'
import { SUBAGENT_STATUS_LABEL } from './subagentStatus'
import { FILES_TOUCHED_LABEL, type ChatScenario, type StageItem, type SubAgentItem } from './viewModel'

/**
 * The header's duration: the wall clock from the first Stage while running (so it ticks), the view-model's total once settled.
 * Clamped at zero because a settled-to-running render still holds the last tick's `now` until the effect refreshes it.
 */
export function panelDurationMs(scenario: Pick<ChatScenario, 'startedAt' | 'totalDurationMs'>, running: boolean, now: number): number | undefined {
  if (scenario.startedAt == null) return undefined
  return running ? Math.max(0, now - scenario.startedAt) : scenario.totalDurationMs
}

/** The panel's own toggle key for a Stage; `panel:` keeps it apart from the chat card's `card:` key (FR-150 d). */
export const panelStageToggleId = (stageId: string): string => `panel:${stageId}`

interface PanelRowBase {
  key: string
  /** What typeahead matches against. */
  label: string
  /** The row's `aria-describedby` text: what the short `aria-label` leaves out (outcome, role, duration, files). Empty when there is none. */
  description: string
  depth: 0 | 1
  posinset: number
  setsize: number
}

export interface PanelStageRow extends PanelRowBase {
  kind: 'stage'
  stage: StageItem
  open: boolean
  ariaLabel: string
}

export interface PanelAgentRow extends PanelRowBase {
  kind: 'agent'
  agent: SubAgentItem
  stageId: string
  /** The Stage's clean title, so a flat row names its agent only when the name differs from it (FR-176). */
  stageTitle: string | null
  ariaLabel: string
}

export type PanelRow = PanelStageRow | PanelAgentRow

/** Same wording the old panel gave a Stage with a "Uses:" line, so a screen reader still hears the dependencies. */
function stagePanelAriaLabel(stage: StageItem): string {
  const base = stageAccessibleName(stage)
  return stage.dependencies.length > 0 ? `${base}, Uses: ${stage.dependencies.map((d) => d.agentId).join(', ')}` : base
}

export function agentPanelAriaLabel(agent: SubAgentItem): string {
  return [agent.name, SUBAGENT_STATUS_LABEL[agent.status], agent.background ? 'Background' : undefined].filter(Boolean).join(', ')
}

/** A Stage's description is its one outcome line, the same text the header shows. */
export function stagePanelDescription(stage: StageItem): string {
  return stageRowModel(stage).outcomePlain ?? ''
}

/** An agent's role, settled duration (a running one ticks, so it is left out), outcome and the whole file list; the row's visible text, spoken on demand. */
export function agentPanelDescription(agent: SubAgentItem): string {
  const files = [...new Set(agent.filesTouched ?? [])].map(fileBasename)
  return [
    agent.role,
    agent.status === 'running' ? undefined : agent.duration,
    agent.whatItDid != null ? plainSummary(agent.whatItDid) : undefined,
    files.length > 0 ? `${FILES_TOUCHED_LABEL}: ${files.join(', ')}` : undefined
  ]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('. ')
}

/** What typeahead matches for a Stage: its clean title, else "Stage N" (the heading the header falls back to). */
export function stagePanelLabel(stage: StageItem): string {
  return stage.cleanTitle ?? `Stage ${stage.number}`
}

export function buildPanelRows(stages: readonly StageItem[], isOpen: (stage: StageItem) => boolean): PanelRow[] {
  const rows: PanelRow[] = []
  stages.forEach((stage, index) => {
    const open = isOpen(stage)
    rows.push({
      kind: 'stage',
      key: stage.id,
      label: stagePanelLabel(stage),
      description: stagePanelDescription(stage),
      depth: 0,
      posinset: index + 1,
      setsize: stages.length,
      stage,
      open,
      ariaLabel: stagePanelAriaLabel(stage)
    })
    if (!open) return
    stage.agents.forEach((agent, agentIndex) =>
      rows.push({
        kind: 'agent',
        key: agent.key,
        label: agent.name,
        description: agentPanelDescription(agent),
        depth: 1,
        posinset: agentIndex + 1,
        setsize: stage.agents.length,
        agent,
        stageId: stage.id,
        stageTitle: stage.cleanTitle,
        ariaLabel: agentPanelAriaLabel(agent)
      })
    )
  })
  return rows
}

export interface PanelSelectionTarget {
  selectedKey: string | null
  selectedId: string | null
  pendingFocusKey: string | null
  pendingFocusId: string | null
}

/** The agent key the panel treats as selected: the store key when it still names an agent, else the agent with the selected id. */
export function resolveSelectedKey(agents: readonly SubAgentItem[], { selectedKey, selectedId }: Pick<PanelSelectionTarget, 'selectedKey' | 'selectedId'>): string | null {
  if (selectedKey && agents.some((agent) => agent.key === selectedKey)) return selectedKey
  if (!selectedId) return null
  return agents.find((agent) => agent.id === selectedId)?.key ?? null
}

/** A Stage holding the selected agent, or one an opener asked to focus, must not auto-collapse out from under it. */
export function stageHoldsTarget(stage: StageItem, selectedKey: string | null, pending: Pick<PanelSelectionTarget, 'pendingFocusKey' | 'pendingFocusId'>): boolean {
  return stage.agents.some(
    (agent) => agent.key === selectedKey || (pending.pendingFocusKey != null && agent.key === pending.pendingFocusKey) || (pending.pendingFocusKey == null && pending.pendingFocusId != null && agent.id === pending.pendingFocusId)
  )
}

/** The Stage that owns the agent an opener asked to focus; null when the agent is not there (yet). */
export function stageOfPendingFocus(stages: readonly StageItem[], pending: Pick<PanelSelectionTarget, 'pendingFocusKey' | 'pendingFocusId'>): StageItem | null {
  if (pending.pendingFocusKey) return stages.find((stage) => stage.agents.some((agent) => agent.key === pending.pendingFocusKey)) ?? null
  if (pending.pendingFocusId) return stages.find((stage) => stage.agents.some((agent) => agent.id === pending.pendingFocusId)) ?? null
  return null
}

/** The Stage's open state, non-latching like the card's (FR-149, FR-150 d): the developer's own toggle wins, else open while running or while it holds the selected or requested agent. */
export function isPanelStageOpen(stage: StageItem, manual: boolean | undefined, selectedKey: string | null, pending: Pick<PanelSelectionTarget, 'pendingFocusKey' | 'pendingFocusId'>): boolean {
  return manual ?? (stage.status === 'running' || stageHoldsTarget(stage, selectedKey, pending))
}

export type PanelKeyAction = { type: 'focus'; index: number } | { type: 'toggle'; stageId: string; open: boolean }

/** The roving-tabindex tree keys (WAI-ARIA tree pattern); null for a key the tree does not handle. */
export function panelKeyAction(rows: readonly PanelRow[], index: number, key: string): PanelKeyAction | null {
  const row = rows[index]
  if (!row) return null
  switch (key) {
    case 'ArrowDown':
      return index + 1 < rows.length ? { type: 'focus', index: index + 1 } : { type: 'focus', index }
    case 'ArrowUp':
      return { type: 'focus', index: Math.max(index - 1, 0) }
    case 'Home':
      return { type: 'focus', index: 0 }
    case 'End':
      return { type: 'focus', index: rows.length - 1 }
    case 'ArrowRight': {
      if (row.kind !== 'stage') return null
      if (!row.open) return { type: 'toggle', stageId: row.stage.id, open: true }
      return rows[index + 1]?.kind === 'agent' ? { type: 'focus', index: index + 1 } : null
    }
    case 'ArrowLeft': {
      if (row.kind === 'stage') return row.open ? { type: 'toggle', stageId: row.stage.id, open: false } : null
      const parent = rows.findIndex((candidate) => candidate.kind === 'stage' && candidate.stage.id === row.stageId)
      return parent === -1 ? null : { type: 'focus', index: parent }
    }
    case 'Enter':
    case ' ':
      return row.kind === 'stage' ? { type: 'toggle', stageId: row.stage.id, open: !row.open } : null
    default:
      return null
  }
}

/** The next row after `fromIndex` (wrapping) whose label starts with `buffer`, or -1. */
export function typeaheadIndex(rows: readonly PanelRow[], fromIndex: number, buffer: string): number {
  const needle = buffer.toLowerCase()
  for (let offset = 1; offset <= rows.length; offset += 1) {
    const candidate = (fromIndex + offset) % rows.length
    if (rows[candidate]!.label.toLowerCase().startsWith(needle)) return candidate
  }
  return -1
}
