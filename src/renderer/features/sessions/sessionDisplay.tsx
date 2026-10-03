// Small display helpers shared between `SessionList.tsx` (the row) and `SessionDetailsCard.tsx`
// (the hover card), split out so neither file has to import the other.

import { BellRingIcon, CircleIcon, LoaderCircleIcon, SquareIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DiffStat } from '../../../shared/ipc'
import type { SessionStatus } from '../../../shared/model'

export const STATUS_LABEL: Record<SessionStatus, string> = {
 working: 'Working',
 idle: 'Idle',
 'needs-you': 'Needs you',
 stopped: 'Stopped'
}

// ISO timestamps sort and compare lexically, so no Date parsing is needed until formatting.
export function formatRelativeTime(iso: string): string {
 const deltaMs = Date.now() - new Date(iso).getTime()
 const minutes = Math.round(deltaMs / 60_000)
 if (minutes < 1) return 'just now'
 if (minutes < 60) return `${minutes}m ago`
 const hours = Math.round(minutes / 60)
 if (hours < 24) return `${hours}h ago`
 const days = Math.round(hours / 24)
 return `${days}d ago`
}

// A distinct icon per Session state, never colour alone (docs/DESIGN.md "Look and feel").
export function StateIcon({ status }: { status: SessionStatus }) {
 const className = 'size-4 shrink-0'
 switch (status) {
  case 'working':
   return <LoaderCircleIcon aria-hidden className={cn(className, 'animate-spin text-state-working')} />
  case 'idle':
   return <CircleIcon aria-hidden className={cn(className, 'text-state-idle')} />
  case 'needs-you':
   return <BellRingIcon aria-hidden className={cn(className, 'text-state-needs-you')} />
  case 'stopped':
   return <SquareIcon aria-hidden className={cn(className, 'text-state-stopped')} />
 }
}

/** `"N files changed +A -D"` (singular "file" for exactly one), with a trailing " (partial)" when
 * the diff stat's caps stopped counting before the real total. */
export function formatDiffStat(stat: DiffStat): string {
 const noun = stat.files === 1 ? 'file' : 'files'
 const suffix = stat.partial ? ' (partial)' : ''
 return `${stat.files} ${noun} changed +${stat.additions} -${stat.deletions}${suffix}`
}
