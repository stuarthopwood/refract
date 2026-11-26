import { CircleIcon } from 'lucide-react'
import { STATUS_GLYPH } from '../../chat/statusGlyph'
import { cn } from '@/lib/utils'
import type { SubStep } from '../viewModel'

export const SUB_STEP_CAP = 6

export interface FoldedSubSteps {
  visible: Array<{ step: SubStep; index: number }>
  /** Older done steps hidden above the list. */
  doneFolded: number
  /** Later pending steps hidden below the list. */
  queued: number
}

// A long list defeats the compact card and an inner scroll area traps the wheel, so the list is capped.
// Running steps always show; the budget left goes to the latest done steps and the next pending ones.
export function foldSubSteps(steps: readonly SubStep[], cap: number = SUB_STEP_CAP): FoldedSubSteps {
  const indexed = steps.map((step, index) => ({ step, index }))
  if (indexed.length <= cap) return { visible: indexed, doneFolded: 0, queued: 0 }
  const running = indexed.filter(({ step }) => step.status === 'running')
  const done = indexed.filter(({ step }) => step.status === 'done')
  const pending = indexed.filter(({ step }) => step.status === 'pending')
  const budget = Math.max(0, cap - running.length)
  const pendingShare = Math.min(pending.length, Math.floor(budget / 2))
  const doneKept = Math.min(done.length, budget - pendingShare)
  const pendingKept = Math.min(pending.length, budget - doneKept)
  const visible = [...done.slice(done.length - doneKept), ...running, ...pending.slice(0, pendingKept)].sort((a, b) => a.index - b.index)
  return { visible, doneFolded: done.length - doneKept, queued: pending.length - pendingKept }
}

const ICON_CLASS = 'size-3.5 shrink-0'

function StepGlyph({ step }: { step: SubStep }) {
  if (step.status === 'pending') return <CircleIcon aria-hidden className={cn(ICON_CLASS, 'text-muted-foreground')} />
  const { Icon, className } = STATUS_GLYPH[step.status === 'running' ? 'running' : step.isError ? 'error' : 'success-done']
  return <Icon aria-hidden className={cn(ICON_CLASS, className, 'motion-reduce:animate-none')} />
}

const STEP_STATE_LABEL: Record<SubStep['status'], string> = { done: 'done', running: 'running', pending: 'queued' }

export function SubStepList({ steps }: { steps: readonly SubStep[] | undefined }) {
  if (steps == null || steps.length === 0) return null
  const { visible, doneFolded, queued } = foldSubSteps(steps)
  return (
    <ul aria-label="Sub-steps" className="space-y-1 text-xs">
      {doneFolded > 0 && <li className="pl-6 text-muted-foreground">{doneFolded} done</li>}
      {visible.map(({ step, index }) => (
        <li key={index} className="flex items-center gap-2">
          <StepGlyph step={step} />
          <span className={cn('min-w-0 truncate', step.status === 'running' ? 'font-medium text-card-foreground' : 'text-muted-foreground')}>
            {step.label}
            <span className="sr-only"> ({step.isError && step.status === 'done' ? 'failed' : STEP_STATE_LABEL[step.status]})</span>
          </span>
        </li>
      ))}
      {queued > 0 && <li className="pl-6 text-muted-foreground">+{queued} queued</li>}
    </ul>
  )
}
