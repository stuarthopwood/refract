// Issue #700/#701 slice (a): one shared pure derive over the retained todo tree
// (`SessionReadout.todoTree`, `src/shared/todo.ts`), so the Todo pill, the pinned panel built in
// this slice, and the Todo card (#700 slice b) plus #687's current-work banner and #526 (both
// still `todo`, per docs/PLAN.md) never each compute done/total/current-task their own way.
// Decision record item 4: "done counts completed tasks, and total excludes abandoned ones.
// Blocked tasks count as open. The pill, card and panel all take these from the one derive."
import type { TodoPhase, TodoTask } from '../../../../shared/todo'

export interface TodoTotals {
  done: number
  total: number
}

/** `false` when there is no task list at all (`todoTree` is `null`, or every phase is empty) --
 * the one check the pill (hidden), the panel (unmounted, decision item 5's "no plan"), and the
 * future card all share, distinct from "every task is done or abandoned" (`isTodoAllDone`
 * below), which still has a real plan to show. A type guard (gate round 1 fix, Main P5): lets
 * every caller narrow `todoTree` to `TodoPhase[]` after an early return, with no `as` cast. */
export function hasTodoPlan(todoTree: TodoPhase[] | null): todoTree is TodoPhase[] {
  return todoTree !== null && todoTree.flatMap((phase) => phase.tasks).length > 0
}

/** `done`/`total` per decision item 4: `total` excludes `abandoned` tasks entirely (neither open
 * nor done); a `blocked` task counts as open (toward `total`, never toward `done`). `null` when
 * `hasTodoPlan` is `false`. */
export function deriveTodoTotals(todoTree: TodoPhase[] | null): TodoTotals | null {
  if (!hasTodoPlan(todoTree)) return null
  const open = todoTree.flatMap((phase) => phase.tasks).filter((t) => t.status !== 'abandoned')
  return { done: open.filter((t) => t.status === 'completed').length, total: open.length }
}

/** Per-phase equivalent of `deriveTodoTotals`, for the pinned panel's own phase headers
 * ("<name> N/M") and `isPhaseFinished` below. */
export function derivePhaseTotals(phase: TodoPhase): TodoTotals {
  const open = phase.tasks.filter((t) => t.status !== 'abandoned')
  return { done: open.filter((t) => t.status === 'completed').length, total: open.length }
}

/** A phase with at least one non-abandoned task, all of them completed -- the panel folds this
 * phase to one line (decision item 5's "Finished phases fold to one line and the current phase
 * stays open"). A phase with every task abandoned (`total: 0`) is NOT "finished": there was
 * never any real work completed in it, so folding it would silently hide an all-abandoned phase
 * as if it were a success. */
export function isPhaseFinished(phase: TodoPhase): boolean {
  const totals = derivePhaseTotals(phase)
  return totals.total > 0 && totals.done === totals.total
}

/** The one `in_progress` task, in phase then task order, WITH its own phase -- the pill's
 * "current task" word, the panel header's "· <current task>", the panel's own manual
 * scroll-follow, and the per-task dedup key (`<phase.name>\0<task.content>`, two phases can
 * legitimately name an identical task) all need the phase alongside the task itself (gate round
 * 1 fix, Main P5: returning only the bare task forced `PinnedTodoPanel.tsx` to keep its own
 * duplicate `findCurrentTask`, which this replaces). `null` when nothing is in progress (nothing
 * started yet, or everything is done/abandoned). */
export function deriveCurrentTask(todoTree: TodoPhase[] | null): { phase: TodoPhase; task: TodoTask } | null {
  if (!todoTree) return null
  for (const phase of todoTree) {
    const task = phase.tasks.find((t) => t.status === 'in_progress')
    if (task) return { phase, task }
  }
  return null
}

/** The panel's own collapsed-to-"All N done" state (decision item 5): a real plan exists and
 * every one of its open (non-abandoned) tasks is completed. */
export function isTodoAllDone(todoTree: TodoPhase[] | null): boolean {
  const totals = deriveTodoTotals(todoTree)
  return totals !== null && totals.total > 0 && totals.done === totals.total
}
