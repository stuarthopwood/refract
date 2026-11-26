import { computeStageLabel } from '../../chat/stageMeta'

/** The Stage's readable title: the synthesised goal when there is one, else the cleaned context or shared-name heuristic. */
export function cleanTitle(input: { overallGoal?: string; context?: string; names: string[] }): string | null {
  const goal = input.overallGoal?.trim()
  if (goal) return goal
  return computeStageLabel(input.context, input.names)
}
