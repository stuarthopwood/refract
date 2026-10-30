import type { SessionDisplayStatus } from './sessionDisplay'
import { cn } from '@/lib/utils'

const TONE: Record<SessionDisplayStatus, string> = {
  idle: 'text-state-idle',
  working: 'text-state-working motion-safe:animate-pulse',
  'needs-you': 'text-state-needs-you',
  stopped: 'text-state-stopped',
  'unread-response': 'text-state-unread-response',
  paused: 'text-state-paused'
}

/** Issue #482: the Dots **Status style**. One shape per state so colour is never the only cue
 * (WCAG 1.4.1): Idle a hollow ring, Working a pulsing filled dot (static under reduced motion),
 *  Needs you a filled dot inside a ring, Stopped a small squarish dot, Unread response an open
  * ring with a badge dot at the top right. Drawn in `currentColor` from the state token; forced colours fall back to
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
    case 'paused':
      return (
        <>
          <rect x="4.5" y="4" width="2.5" height="8" rx="0.75" fill="currentColor" />
          <rect x="9" y="4" width="2.5" height="8" rx="0.75" fill="currentColor" />
        </>
      )
    case 'unread-response':
      return (
        <>
          <circle cx="7.5" cy="8.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12.5" cy="3.5" r="2.5" fill="currentColor" />
        </>
      )
  }
}
