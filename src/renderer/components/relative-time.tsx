import * as React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatRelativeTime } from '@/features/sessions/sessionDisplay'

const FULL_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short'
})

// "23 Oct 2026, 11:06 BST" in the user's local time zone.
export function formatFullDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return FULL_FORMAT.format(date)
}

// A relative time as a `<time datetime>` with the full local date and time in a shared Tooltip,
// on hover and keyboard focus. Focusable so keyboard users can reach the tooltip; the visible
// relative text stays the accessible name (WCAG 2.5.3) and Radix describes it with the tooltip.
export function RelativeTime({ value, className }: { value: string; className?: string }) {
  const full = formatFullDateTime(value)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={value}
          tabIndex={0}
          className={cn('rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', className)}
        >
          {formatRelativeTime(value)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  )
}
