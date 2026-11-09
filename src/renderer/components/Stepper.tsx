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
  running: 'border-transparent text-foreground',
  passed: 'border-state-working text-state-working shadow-[0_0_14px_color-mix(in_oklab,var(--state-working)_45%,transparent)]',
  failed: 'border-destructive text-destructive'
}

const STATUS_TEXT_CLASS: Record<StepStatus, string> = {
  waiting: 'text-muted-foreground',
  running: 'text-accent-text',
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
        'relative flex size-(--stepper-marker) items-center justify-center rounded-full border-2 bg-background text-base font-medium',
        selected && 'outline-2 outline-offset-4 outline-accent-text',
        CIRCLE_CLASS[status]
      )}
    >
      {status === 'passed' ? <CheckIcon className="size-5 sm:size-6" /> : status === 'failed' ? <CircleAlertIcon className="size-5 sm:size-6" /> : index}
      {status === 'running' && (
        <span
          data-stepper-spinner
          className="absolute -inset-0.5 animate-spin rounded-full border-2 border-transparent border-r-accent-text border-t-accent-text motion-reduce:animate-none"
        />
      )}
    </span>
  )
}

/** One connector per gap: it spans exactly from circle N's outermost ring (circle + selection ring clearance) to circle N+1's, at the circles' vertical centre, so nothing draws inside a circle. Fills from the success colour into the accent colour as the previous step passes. */
function StepConnector({ filled }: { filled: boolean }) {
  return (
    <span
      aria-hidden
      className="absolute top-[calc(0.5rem+var(--stepper-marker)/2)] left-[calc(-50%+var(--stepper-marker)/2+var(--stepper-ring))] h-0.5 w-[calc(100%-var(--stepper-marker)-2*var(--stepper-ring))] overflow-hidden rounded-full bg-border"
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

/** A horizontal progress track of numbered steps; each step is a button that selects its detail. */
export function Stepper({ label, steps, selectedKey, onSelect, detailId }: StepperProps) {
  return (
    <ol role="list" aria-label={label} className="m-0 flex list-none p-0 [--stepper-marker:2.5rem] [--stepper-ring:0.375rem] sm:[--stepper-marker:3rem]">
      {steps.map((step, i) => {
        const selected = step.key === selectedKey
        return (
          <li key={step.key} data-step-status={step.status} className="relative flex min-w-0 flex-1 flex-col">
            {i > 0 && <StepConnector filled={steps[i - 1]?.status === 'passed'} />}
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Step ${i + 1} of ${steps.length}, ${step.title}, ${STEP_STATUS_WORD[step.status]}`}
              aria-pressed={selected}
              aria-controls={detailId}
              onClick={() => onSelect(step.key)}
              className="relative h-auto min-w-0 flex-col items-center justify-start gap-2 whitespace-normal px-1 pb-2 pt-2 text-center"
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
