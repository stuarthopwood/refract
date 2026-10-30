// One shared derive over the retained todo tree so the pill, panel and card agree on done/total/current task.
// `done` counts completed tasks; `total` excludes abandoned ones; blocked tasks count as open.
import type { TodoPhase, TodoTask } from '../../../../shared/todo'

export interface TodoTotals {
  done: number
  total: number
}

/** `false` when there is no task list at all (`todoTree` is `null` or every phase is empty). */
export function hasTodoPlan(todoTree: TodoPhase[] | null): todoTree is TodoPhase[] {
  return todoTree !== null && todoTree.flatMap((phase) => phase.tasks).length > 0
}

/** `done`/`total`: `total` excludes `abandoned` tasks; a `blocked` task counts as open. */
export function deriveTodoTotals(todoTree: TodoPhase[] | null): TodoTotals | null {
  if (!hasTodoPlan(todoTree)) return null
  const open = todoTree.flatMap((phase) => phase.tasks).filter((t) => t.status !== 'abandoned')
  return { done: open.filter((t) => t.status === 'completed').length, total: open.length }
}

/** Per-phase equivalent of `deriveTodoTotals`, for the pinned panel's own phase headers ("<name> N/M") and `isPhaseFinished` below. */
export function derivePhaseTotals(phase: TodoPhase): TodoTotals {
  const open = phase.tasks.filter((t) => t.status !== 'abandoned')
  return { done: open.filter((t) => t.status === 'completed').length, total: open.length }
}

/** A phase with at least one non-abandoned task, all completed. */
export function isPhaseFinished(phase: TodoPhase): boolean {
  const totals = derivePhaseTotals(phase)
  return totals.total > 0 && totals.done === totals.total
}

/** The first `in_progress` task in phase then task order, with its phase and both indices. */
export function deriveCurrentTask(todoTree: TodoPhase[] | null): { phase: TodoPhase; task: TodoTask; phaseIndex: number; taskIndex: number } | null {
  if (!todoTree) return null
  for (const [phaseIndex, phase] of todoTree.entries()) {
    for (const [taskIndex, task] of phase.tasks.entries()) {
      if (task.status === 'in_progress') return { phase, task, phaseIndex, taskIndex }
    }
  }
  return null
}

/** True when a plan exists and every non-abandoned task is complete. */
export function isTodoAllDone(todoTree: TodoPhase[] | null): boolean {
  const totals = deriveTodoTotals(todoTree)
  return totals !== null && totals.total > 0 && totals.done === totals.total
}
