import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type StepStatus = 'pending' | 'done' | 'failed'

/** An ordered list of steps; the failed step passes `expanded` content as children. */
export function Stepper({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol aria-label={label} className="flex flex-col gap-3">
      {children}
    </ol>
  )
}

export interface StepperItemProps {
  /** 1-based position, shown in the marker. */
  index: number
  status: StepStatus
  title: ReactNode
  /** Rendered under the title; callers pass it only for the step that needs attention. */
  children?: ReactNode
}

// The marker is colour plus a glyph (✓, ✕, number) so state never relies on colour alone.
export function StepperItem({ index, status, title, children }: StepperItemProps) {
  const glyph = status === 'done' ? '✓' : status === 'failed' ? '✕' : String(index)
  return (
    <li className="flex items-start gap-3" data-step-status={status}>
      <span
        aria-hidden
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
          status === 'done' && 'border-state-working text-state-working',
          status === 'failed' && 'border-destructive text-destructive',
          status === 'pending' && 'border-border text-muted-foreground'
        )}
      >
        {glyph}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className={cn('text-sm', status === 'failed' && 'font-medium')}>{title}</span>
        {children}
      </div>
    </li>
  )
}
