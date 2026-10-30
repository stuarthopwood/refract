import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

type Tone = 'info' | 'loading' | 'notice' | 'error'

// An error is `alert`; loading and a quiet notice (a failed background refresh) are `status`; plain info announces nothing.
const ROLE: Record<Tone, 'alert' | 'status' | undefined> = { info: undefined, loading: 'status', notice: 'status', error: 'alert' }

/** One line of loading, error or empty text in a pane. `block` fills a pane, `compact` sits inside a list or tree. */
export function InlineStatus({
  tone = 'info',
  density = 'block',
  className,
  ...props
}: Omit<ComponentProps<'p'>, 'role'> & { tone?: Tone; density?: 'block' | 'compact' }) {
  return (
    <p
      data-slot="inline-status"
      data-tone={tone}
      role={ROLE[tone]}
      className={cn(
        density === 'block' ? 'p-4 text-sm' : 'px-2 py-1 text-xs',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}
