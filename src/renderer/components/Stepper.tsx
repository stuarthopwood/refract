import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type StepStatus = 'waiting' | 'running' | 'passed' | 'failed'

/** The visible and spoken status word for each state. */
export const STEP_STATUS_WORD: Record<StepStatus, string> = {
  waiting: 'Waiting',
  running: 'Running',
  passed: 'Verified',
  failed: 'Failed'
}

const CIRCLE_CLASS: Record<StepStatus, string> = {
  waiting: 'border-border text-muted-foreground',
  running: 'border-transparent text-accent-text',
  passed: 'border-state-working text-state-working shadow-[0_0_14px_color-mix(in_oklab,var(--state-working)_45%,transparent)]',
  failed: 'border-destructive text-destructive'
}

const STATUS_TEXT_CLASS: Record<StepStatus, string> = {
  waiting: 'text-muted-foreground',
  // The ghost button's hover fill is `muted`, where accent-text only clears 3:1; hover swaps to foreground so the word keeps 4.5:1.
  running: 'text-accent-text group-hover/button:text-foreground',
  passed: 'text-state-working',
  failed: 'text-destructive'
}

export interface StepperStep {
  key: string
  title: string
  status: StepStatus
}

export interface StepperProps {
  label: string
  steps: readonly StepperStep[]
  /** The step whose detail is showing; `null` selects none. */
  selectedKey: string | null
  onSelect: (key: string) => void
  /** Id of the region that shows the selected step's detail (`aria-controls`). */
  detailId: string
}

// State is always an icon or glyph plus the status word, never colour alone. The marker is the
// circle itself; the selection ring is an offset outline so it adds no layout size. While running
// the circle keeps no border of its own: only a spinning arc rings the number.
function StepMarker({ index, status, selected }: { index: number; status: StepStatus; selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex size-(--stepper-marker) items-center justify-center rounded-full border-2 bg-background text-sm font-medium',
        selected && 'outline-2 outline-offset-4 outline-accent-text',
        CIRCLE_CLASS[status]
      )}
    >
      {status === 'passed' ? <CheckIcon className="size-4 sm:size-5" /> : status === 'failed' ? <CircleAlertIcon className="size-4 sm:size-5" /> : index}
      {status === 'running' && (
        <span
          data-stepper-spinner
          style={{ inset: -2 }}
          className="absolute animate-spin rounded-full border-2 border-transparent border-r-accent-text border-t-accent-text motion-reduce:animate-none"
        />
      )}
    </span>
  )
}

/** One connector per gap, from circle N's outermost ring to circle N+1's so it touches each ring without entering it. A circle's outermost ring is its own edge, or the selection outline (`--stepper-ring`) when selected. `100cqw` is the list's width (the size container). `top` is the button's 1px border plus its 0.5rem padding plus half a circle, so the line's centre is the circle centre. Fills from the success colour into the accent colour as the previous step passes. */
function StepConnector({ count, filled, startSelected, endSelected }: { count: number; filled: boolean; startSelected: boolean; endSelected: boolean }) {
  const start = startSelected ? 'var(--stepper-ring)' : '0px'
  const end = endSelected ? 'var(--stepper-ring)' : '0px'
  const gap = `((100cqw - ${count} * var(--stepper-marker)) / ${count - 1})`
  return (
    <span
      aria-hidden
      style={{
        left: `calc(-1 * ${gap} + ${start})`,
        width: `max(0px, calc(${gap} - ${start} - ${end}))`
      }}
      className="absolute top-[calc(1px+0.5rem+var(--stepper-marker)/2)] h-0.5 -translate-y-1/2 overflow-hidden rounded-full bg-border"
    >
      <span
        className={cn(
          'block size-full origin-left bg-linear-to-r from-state-working from-60% to-accent-text transition-transform duration-500 motion-reduce:transition-none',
          filled ? 'scale-x-100' : 'scale-x-0'
        )}
      />
    </span>
  )
}

/**
 * A horizontal progress track of numbered steps; each step is a button that selects its detail.
 * The first and last circle centres sit on the list's own box edges (the list bleeds half a circle
 * past its parent), so a parent that shares its width with another element lines the circles up
 * with that element's edges. Labels are wider than the circle and centred under it.
 */
export function Stepper({ label, steps, selectedKey, onSelect, detailId }: StepperProps) {
  return (
    <ol
      role="list"
      aria-label={label}
      className="-mx-[calc(var(--stepper-marker)/2)] m-0 flex list-none justify-between p-0 [container-type:inline-size] [--stepper-marker:2rem] [--stepper-ring:0.375rem] sm:[--stepper-marker:2.5rem]"
    >
      {steps.map((step, i) => {
        const selected = step.key === selectedKey
        return (
          <li key={step.key} data-step-status={step.status} className="relative flex w-(--stepper-marker) flex-col items-center">
            {i > 0 && (
              <StepConnector count={steps.length} filled={steps[i - 1]?.status === 'passed'} startSelected={steps[i - 1]?.key === selectedKey} endSelected={selected} />
            )}
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Step ${i + 1} of ${steps.length}, ${step.title}, ${STEP_STATUS_WORD[step.status]}`}
              aria-pressed={selected}
              aria-controls={detailId}
              onClick={() => onSelect(step.key)}
              className="relative h-auto w-16 max-w-none shrink-0 flex-col items-center justify-start gap-2 whitespace-normal px-0 pb-2 pt-2 text-center sm:w-26 sm:px-1"
            >
              <StepMarker index={i + 1} status={step.status} selected={selected} />
              <span className="text-xs font-medium text-foreground [overflow-wrap:anywhere] sm:text-sm">{step.title}</span>
              <span className={cn('text-xs', STATUS_TEXT_CLASS[step.status])}>{STEP_STATUS_WORD[step.status]}</span>
            </Button>
          </li>
        )
      })}
    </ol>
  )
}
