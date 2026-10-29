// Issue #700/#701 slice (b), decision record item 1: the Todo hover-focus card -- "the tree
// (phases, tasks with glyph plus word for pending, in progress, completed, blocked with
// blocker, abandoned)", shown inside `Readouts.tsx`'s `TodoProgressReadout`'s own Popover. The
// row rendering (`TodoPhaseGroup`/`TodoTaskRow`) is the SAME shared component slice (a)'s
// `PinnedTodoPanel.tsx` already uses (`TodoTree.tsx`) -- this card never re-implements a task
// row a second way. Unlike the pinned panel, this is a momentary glance (no collapse, no
// Unpin): every phase is always expanded (`foldFinished={false}`), capped by a plain CSS scroll.
import { useLayoutEffect, useRef } from 'react'
import type { TodoPhase } from '../../../../shared/todo'
import { currentTaskKeyOf, TodoPhaseGroup } from './TodoTree'
import { deriveCurrentTask, deriveTodoTotals } from './todoDerive'

export function TodoCard({ todoTree }: { todoTree: TodoPhase[] }) {
  const found = deriveCurrentTask(todoTree)
  const currentTaskKey = found ? currentTaskKeyOf(found.phaseIndex, found.taskIndex) : null
  // Gate round 1 fix 7: the SAME `deriveTodoTotals` the pill itself reads, so the card's own
  // header can never disagree with the pill's own "Todo d/t" figure.
  const totals = deriveTodoTotals(todoTree)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Gate round 1 fix 7: keeps the in-progress task in view within the card's own capped scroll
  // the instant it opens (and on every later render, matching `PinnedTodoPanel.tsx`'s own
  // already-debugged approach -- a plain read plus a conditional write, a no-op once the row is
  // already fully in view, so re-running every render costs nothing). Never `scrollIntoView`,
  // which can scroll an ancestor (the Popover's own positioning wrapper, the page) instead of
  // just this list.
  useLayoutEffect(() => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('[data-current-task="true"]')
    if (!list || !el) return
    const listRect = list.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const elTop = elRect.top - listRect.top + list.scrollTop
    const elBottom = elTop + elRect.height
    if (elRect.height > list.clientHeight) {
      if (list.scrollTop !== elTop) list.scrollTop = elTop
    } else if (elTop < list.scrollTop) {
      list.scrollTop = elTop
    } else if (elBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = elBottom - list.clientHeight
    }
  })

  return (
    <div className="w-64" aria-label="Todo list preview">
      {totals && <div data-slot="todo-card-header" className="text-xs text-foreground">{`${totals.done} of ${totals.total}`}</div>}
      <div ref={listRef} className="mt-2 max-h-[min(16rem,40vh)] overflow-y-auto">
        {todoTree.map((phase, phaseIndex) => (
          <TodoPhaseGroup
            key={phaseIndex}
            phase={phase}
            phaseIndex={phaseIndex}
            showHeader={todoTree.length > 1}
            currentTaskKey={currentTaskKey}
            foldFinished={false}
          />
        ))}
      </div>
    </div>
  )
}
