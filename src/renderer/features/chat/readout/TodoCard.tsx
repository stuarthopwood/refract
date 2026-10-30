import { useLayoutEffect, useRef } from 'react'
import type { TodoPhase } from '../../../../shared/todo'
import { currentTaskKeyOf, TodoPhaseGroup } from './TodoTree'
import { deriveCurrentTask, deriveTodoTotals } from './todoDerive'

/** Hover card showing the full todo tree, always expanded. */
export function TodoCard({ todoTree }: { todoTree: TodoPhase[] }) {
  const found = deriveCurrentTask(todoTree)
  const currentTaskKey = found ? currentTaskKeyOf(found.phaseIndex, found.taskIndex) : null
  const totals = deriveTodoTotals(todoTree)
  const listRef = useRef<HTMLDivElement | null>(null)

  // Not `scrollIntoView`: it can scroll an ancestor (popover wrapper, page) instead of this list.
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
