import type { ComponentProps } from 'react'
import { CheckIcon, Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InlineStatus } from './InlineStatus'
import { describeSaveStatus } from './saveStatusView'
import type { SaveState } from './saveStatusView'

const ICON_CLASS = 'mr-1 inline size-4 shrink-0 align-[-0.2em]'

/** Saving…, Saved or the write's error as one line of text with an icon; renders nothing when idle. */
export function SaveStatus({ state, error, className, ...props }: Omit<ComponentProps<typeof InlineStatus>, 'tone' | 'density' | 'leading' | 'children'> & { state: SaveState; error?: string }) {
  const view = describeSaveStatus(state, error)
  if (!view) return null
  const leading = view.icon === 'spinner' ? <Loader2Icon aria-hidden className={cn(ICON_CLASS, 'animate-spin')} /> : view.icon === 'check' ? <CheckIcon aria-hidden className={ICON_CLASS} /> : undefined
  return (
    <InlineStatus tone={view.tone} density="compact" leading={leading} className={cn('px-0 py-0', className)} {...props}>
      {view.text}
    </InlineStatus>
  )
}
