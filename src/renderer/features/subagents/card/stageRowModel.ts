// What a Stage header shows, derived from the shared view-model so the chat card and the panel agree (#1927, #1930, FR-147, FR-150).
import { formatElapsed } from '../../chat/formatElapsed'
import { stageHeading } from '../../chat/stageMeta'
import { SUBAGENT_STATUS_LABEL } from '../subagentStatus'
import type { StageItem, SubAgentItem } from '../viewModel/types'

export type StageRowView = Pick<StageItem, 'agents' | 'cleanTitle' | 'outcomeSummary' | 'rawLabel' | 'status'>

/** The Stage row's spoken name: heading, roll-up, "Running" only while running, and the duration when known. */
export function stageAccessibleName(stage: Pick<StageItem, 'number' | 'cleanTitle' | 'rollupText' | 'status' | 'durationMs'>): string {
  const parts = [stageHeading(stage.number, stage.cleanTitle, true), stage.rollupText]
  if (stage.status === 'running') parts.push(SUBAGENT_STATUS_LABEL.running)
  if (stage.durationMs != null) parts.push(formatElapsed(stage.durationMs))
  return parts.join(', ')
}

export interface StageRowModel {
  /** The one agent a single-agent Stage shows as an inline chip; null for several agents. */
  chipAgent: SubAgentItem | null
  /** Agents in a parallel Stage; 0 when the Stage is not parallel, so no badge is drawn. */
  parallelCount: number
  /** One line under the title: the settled outcome, else a running agent's live focus. */
  outcome?: string
  /** Shown only in the header tooltip, and only when it says more than the clean title. */
  rawLabel?: string
}

export function stageRowModel(view: StageRowView): StageRowModel {
  const { agents } = view
  const outcome = view.outcomeSummary?.trim() || (view.status === 'running' ? agents.find((agent) => agent.status === 'running')?.liveDetail?.trim() : undefined)
  const rawLabel = view.rawLabel?.trim()
  return {
    chipAgent: agents.length === 1 ? (agents[0] ?? null) : null,
    parallelCount: agents.length > 1 ? agents.length : 0,
    outcome: outcome || undefined,
    rawLabel: rawLabel && rawLabel !== view.cleanTitle ? rawLabel : undefined
  }
}

// Two columns from the card's own 448px (`@md`), never the viewport, so a narrow chat column stays one column.
const PARALLEL_GRID_CLASS = '@md:grid @md:grid-cols-2 @md:gap-1 @md:space-y-0'
// A column-2 member would draw its elbow tick floating mid-row, so only the left column keeps one.
const PARALLEL_ITEM_CLASS = '@md:even:[&>span:first-child]:hidden'

export function stageAgentsGridClass(parallelCount: number): string | undefined {
  return parallelCount > 1 ? PARALLEL_GRID_CLASS : undefined
}

export function stageAgentItemClass(parallelCount: number): string | undefined {
  return parallelCount > 1 ? PARALLEL_ITEM_CLASS : undefined
}
