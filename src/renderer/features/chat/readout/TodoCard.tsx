// Issue #700/#701 slice (b), decision record item 1: the Todo hover-focus card -- "the tree
// (phases, tasks with glyph plus word for pending, in progress, completed, blocked with
// blocker, abandoned)", shown inside `ReadoutChips.tsx`'s `TodoProgressChip`'s own Popover. The
// row rendering (`TodoPhaseGroup`/`TodoTaskRow`) is the SAME shared component slice (a)'s
// `PinnedTodoPanel.tsx` already uses (`TodoTree.tsx`) -- this card never re-implements a task
// row a second way. Unlike the pinned panel, this is a momentary glance (no scroll-follow, no
// collapse, no Unpin): every phase is always expanded, capped by a plain CSS scroll instead.
import type { TodoPhase } from '../../../../shared/todo'
import { currentTaskKeyOf, TodoPhaseGroup } from './TodoTree'
import { deriveCurrentTask } from './todoDerive'

export function TodoCard({ todoTree }: { todoTree: TodoPhase[] }) {
  const found = deriveCurrentTask(todoTree)
  const currentTaskKey = found ? currentTaskKeyOf(found.phaseIndex, found.taskIndex) : null
  return (
    <div className="max-h-[min(16rem,40vh)] w-64 overflow-y-auto">
      {todoTree.map((phase, phaseIndex) => (
        <TodoPhaseGroup key={phaseIndex} phase={phase} phaseIndex={phaseIndex} showHeader={todoTree.length > 1} currentTaskKey={currentTaskKey} />
      ))}
    </div>
  )
}
