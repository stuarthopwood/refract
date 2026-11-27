// What a Stage header shows, derived from the shared view-model so the chat card and the panel agree (#1927, #1930, FR-147, FR-150).
import { formatElapsed } from '../../chat/formatElapsed'
import { plainSummary, stageHeading } from '../../chat/stageMeta'
import { SUBAGENT_STATUS_LABEL } from '../subagentStatus'
import type { StageItem, SubAgentItem } from '../viewModel/types'

export type StageRowView = Pick<StageItem, 'agents' | 'cleanTitle' | 'outcomeSummary' | 'rawLabel' | 'status'>

/** The Stage row's spoken name: heading, roll-up, "Running" while running, and the duration once settled (a ticking value is never spoken). */
export function stageAccessibleName(stage: Pick<StageItem, 'number' | 'cleanTitle' | 'rollupText' | 'status' | 'durationMs'>): string {
  const parts = [stageHeading(stage.number, stage.cleanTitle, true), stage.rollupText]
  if (stage.status === 'running') parts.push(SUBAGENT_STATUS_LABEL.running)
  else if (stage.durationMs != null) parts.push(formatElapsed(stage.durationMs))
  return parts.join(', ')
}

export interface StageRowModel {
  /** The one agent a single-agent Stage names as quiet text; null for several agents, or when its name just repeats the Stage title (FR-176). */
  chipAgent: SubAgentItem | null
  /** Agents in a parallel Stage; 0 when the Stage is not parallel, so no badge is drawn. */
  parallelCount: number
  /** One line under the title: the settled outcome, else a running agent's live focus. Markdown: render it, never print it raw. */
  outcome?: string
  /** `outcome` as plain words, for a tooltip or an accessible description. */
  outcomePlain?: string
  /** Shown only in the header tooltip, and only when it says more than the clean title. */
  rawLabel?: string
}

export function stageRowModel(view: StageRowView): StageRowModel {
  const { agents } = view
  const outcome = view.outcomeSummary?.trim() || (view.status === 'running' ? agents.find((agent) => agent.status === 'running')?.liveDetail?.trim() : undefined)
  const rawLabel = view.rawLabel?.trim()
  const solo = agents.length === 1 ? (agents[0] ?? null) : null
  const repeatsTitle = solo != null && view.cleanTitle != null && solo.name.trim().toLowerCase() === view.cleanTitle.trim().toLowerCase()
  return {
    chipAgent: repeatsTitle ? null : solo,
    parallelCount: agents.length > 1 ? agents.length : 0,
    outcome: outcome || undefined,
    outcomePlain: outcome ? plainSummary(outcome) : undefined,
    rawLabel: rawLabel && rawLabel !== view.cleanTitle ? rawLabel : undefined
  }
}

// Two columns from the card's own 448px (`@md`), never the viewport, so a narrow chat column stays one column.
const PARALLEL_GRID_CLASS = '@md:grid @md:grid-cols-2 @md:gap-1 @md:space-y-0'

export function stageAgentsGridClass(parallelCount: number): string | undefined {
  return parallelCount > 1 ? PARALLEL_GRID_CLASS : undefined
}
