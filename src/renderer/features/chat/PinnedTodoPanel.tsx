// Issue #700/#701 slice (a), decision record item 5: the pinned todo panel -- the live-updating
// tree for THIS Session, mounted in `ChatPane.tsx` directly above the composer (where the #687
// current-work banner will eventually sit; #687 itself is still `todo`, per `docs/PLAN.md`) only
// while `useTodoPinStore`'s per-Session `pinned` flag is set. The Todo pill
// (`ReadoutChips.tsx`'s `TodoProgressChip`) toggles that flag; this panel's own header carries
// the reverse Unpin control too, since the pill itself can be hidden in Settings (`sessionReadout
// ['todo-progress']`). Unmounts entirely once there is no plan at all (`hasTodoPlan` false), but
// the pin flag itself survives into the next plan (decision item 5: "the pin stays") -- this
// component only ever reads `pinned`, never clears it.
import { useLayoutEffect, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { CheckCircle2Icon, ChevronDownIcon, CircleAlertIcon, CircleDotIcon, CircleIcon, CircleSlashIcon, PinOffIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useTodoPinStore } from '@/state'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TodoPhase, TodoTask, TodoTaskStatus } from '../../../shared/todo'
import { derivePhaseTotals, deriveTodoTotals, hasTodoPlan, isPhaseFinished } from './readout/todoDerive'

// Decision item 5's own status-icon table: In progress/Blocked/Abandoned show a visible word
// (`srOnly: false`); Pending/Done show the SAME word to a screen reader only (`srOnly: true`),
// since their icon+position already reads clearly for a sighted user. No icon is named for
// `pending` in the decision record (only in progress/done/abandoned/blocked are); a plain empty
// `Circle`, muted, is the only one of the five states left needing a shape of its own.
const TASK_STATUS_GLYPH: Record<TodoTaskStatus, { Icon: LucideIcon; className: string; word: string; srOnly: boolean }> = {
  pending: { Icon: CircleIcon, className: 'text-muted-foreground', word: 'Pending', srOnly: true },
  in_progress: { Icon: CircleDotIcon, className: 'text-state-working', word: 'In progress', srOnly: false },
  completed: { Icon: CheckCircle2Icon, className: 'text-muted-foreground', word: 'Done', srOnly: true },
  blocked: { Icon: CircleAlertIcon, className: 'text-severity-warning', word: 'Blocked', srOnly: false },
  abandoned: { Icon: CircleSlashIcon, className: 'text-muted-foreground', word: 'Abandoned', srOnly: false }
}

function currentTaskKeyOf(phase: TodoPhase, task: TodoTask): string {
  return `${phase.name}\u0000${task.content}`
}

export function PinnedTodoPanel({ sessionId }: { sessionId: string }) {
  const todoTree = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.todoTree)
  const pinned = useTodoPinStore((s) => s.pinnedBySession[sessionId] ?? false)
  const collapsed = useTodoPinStore((s) => s.collapsedBySession[sessionId] ?? false)
  const setCollapsed = useTodoPinStore((s) => s.setCollapsed)
  const setPinned = useTodoPinStore((s) => s.setPinned)

  const listRef = useRef<HTMLDivElement | null>(null)
  // Decision item 5: "follows the in-progress task with `scrollIntoView({block:'nearest'})` only
  // when that task changes, and stops once the user scrolls" -- `userScrolledRef` is a plain,
  // one-way latch (set by the list's own `onScroll`, never cleared here); `lastFollowedKeyRef`
  // guards against re-scrolling on a re-render that changes some OTHER field (another task's
  // status, a blocker string) while the in-progress task itself stays the same.
  const userScrolledRef = useRef(false)
  const lastFollowedKeyRef = useRef<string | null>(null)
  const found = todoTree ? findCurrentTask(todoTree) : null
  const currentTaskKey = found ? currentTaskKeyOf(found.phase, found.task) : null

  useLayoutEffect(() => {
    if (userScrolledRef.current) return
    if (currentTaskKey === null || currentTaskKey === lastFollowedKeyRef.current) return
    lastFollowedKeyRef.current = currentTaskKey
    listRef.current?.querySelector<HTMLElement>('[data-current-task="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [currentTaskKey])

  if (!pinned || !hasTodoPlan(todoTree)) return null
  const tree = todoTree as TodoPhase[]
  const totals = deriveTodoTotals(tree) as { done: number; total: number }
  const allDone = totals.total > 0 && totals.done === totals.total
  const currentTask = found?.task ?? null

  return (
    <div id={`todo-panel-${sessionId}`} data-slot="pinned-todo-panel" aria-label="Todo list" aria-live="off" className="shrink-0 border-t border-divider px-4 py-1.5">
      <div className="flex h-6 items-center gap-0.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {allDone ? `All ${totals.total} done` : currentTask ? `Todo ${totals.done}/${totals.total} \u00b7 ${currentTask.content}` : `Todo ${totals.done}/${totals.total}`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand todo list' : 'Collapse todo list'}
          onClick={() => setCollapsed(sessionId, !collapsed)}
        >
          <ChevronDownIcon aria-hidden className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Unpin todo list" onClick={() => setPinned(sessionId, false)}>
          <PinOffIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      {!collapsed && (
        <div
          ref={listRef}
          onScroll={() => {
            userScrolledRef.current = true
          }}
          className="mt-1 max-h-[min(12rem,30vh)] overflow-y-auto"
        >
          {tree.map((phase, phaseIndex) => (
            <TodoPhaseGroup key={`${phase.name}-${phaseIndex}`} phase={phase} showHeader={tree.length > 1} currentTaskKey={currentTaskKey} />
          ))}
        </div>
      )}
    </div>
  )
}

// Phase+task position, not just task content, since two phases could legitimately name an
// identical task; walked once per render rather than inside `deriveCurrentTask` (which only
// returns the bare `TodoTask`, with no phase of its own to build a dedup key from).
function findCurrentTask(todoTree: TodoPhase[]): { phase: TodoPhase; task: TodoTask } | null {
  for (const phase of todoTree) {
    const task = phase.tasks.find((t) => t.status === 'in_progress')
    if (task) return { phase, task }
  }
  return null
}

function TodoPhaseGroup({ phase, showHeader, currentTaskKey }: { phase: TodoPhase; showHeader: boolean; currentTaskKey: string | null }) {
  // Decision item 5: "Finished phases fold to one line and the current phase stays open. A
  // single phase gets no header" -- `showHeader` is `false` for the single-phase case, so
  // `finished` folding never applies there either (nothing to fold a header line DOWN to).
  const folded = showHeader && isPhaseFinished(phase)
  const phaseTotals = derivePhaseTotals(phase)
  return (
    <div className="py-0.5">
      {showHeader && (
        <div className="px-1 text-[11px] font-medium text-muted-foreground">
          {phase.name} {phaseTotals.done}/{phaseTotals.total}
        </div>
      )}
      {!folded && (
        <ul className="space-y-0.5">
          {phase.tasks.map((task, taskIndex) => (
            <TodoTaskRow key={`${task.content}-${taskIndex}`} task={task} isCurrent={currentTaskKeyOf(phase, task) === currentTaskKey} />
          ))}
        </ul>
      )}
    </div>
  )
}

function TodoTaskRow({ task, isCurrent }: { task: TodoTask; isCurrent: boolean }) {
  const { Icon, className, word, srOnly } = TASK_STATUS_GLYPH[task.status]
  return (
    <li data-current-task={isCurrent || undefined} className="flex items-start gap-1.5 px-1 py-0.5 text-xs">
      <Icon aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', className)} />
      <div className="min-w-0 flex-1">
        <span className={cn('block break-words', task.status === 'in_progress' && 'font-medium', task.status === 'abandoned' && 'text-muted-foreground line-through')}>
          <span className={srOnly ? 'sr-only' : 'mr-1'}>{word}</span>
          {task.content}
        </span>
        {task.status === 'blocked' && task.blocker && <span className="block text-severity-warning">Blocked: {task.blocker}</span>}
      </div>
    </li>
  )
}
