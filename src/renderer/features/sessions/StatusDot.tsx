import type { SessionDisplayStatus } from './sessionDisplay'
import { cn } from '@/lib/utils'

const TONE: Record<SessionDisplayStatus, string> = {
  idle: 'text-state-idle',
  working: 'text-state-working motion-safe:animate-pulse',
  'needs-you': 'text-state-needs-you',
  stopped: 'text-state-stopped',
  'unread-response': 'text-state-unread-response'
}

/** Issue #482: the Dots **Status style**. One shape per state so colour is never the only cue
 * (WCAG 1.4.1): Idle a hollow ring, Working a pulsing filled dot (static under reduced motion),
 * Needs you a filled dot inside a ring, Stopped a small squarish dot, Unread response a ring with
 * an inner dot. Drawn in `currentColor` from the state token; forced colours fall back to
 * CanvasText. Decorative: the caller's `sr-only` status word carries the meaning. */
export function StatusDot({ status, className }: { status: SessionDisplayStatus; className?: string }) {
  return (
    <svg
      aria-hidden
      focusable={false}
      viewBox="0 0 16 16"
      className={cn('size-4 shrink-0 forced-colors:text-[CanvasText]', TONE[status], className)}
    >
      <DotShape status={status} />
    </svg>
  )
}

function DotShape({ status }: { status: SessionDisplayStatus }) {
  switch (status) {
    case 'idle':
      return <circle cx="8" cy="8" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
    case 'working':
      return <circle cx="8" cy="8" r="4.5" fill="currentColor" />
    case 'needs-you':
      return (
        <>
          <circle cx="8" cy="8" r="3.5" fill="currentColor" />
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
        </>
      )
    case 'stopped':
      return <rect x="5" y="5" width="6" height="6" rx="1.25" fill="currentColor" />
    case 'unread-response':
      return (
        <>
          <circle cx="8" cy="8" r="2" fill="currentColor" />
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      )
  }
}
