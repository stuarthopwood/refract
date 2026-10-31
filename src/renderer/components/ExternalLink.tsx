import type { ComponentProps } from 'react'
import { ExternalLinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A link that opens in the browser, with the icon and the screen-reader hint every such link needs. */
export function ExternalLink({ className, children, ...props }: Omit<ComponentProps<'a'>, 'target' | 'rel'>) {
  // Only https opens; any other scheme (javascript:, file:, http:) renders as inert text.
  if (!props.href?.startsWith('https://')) return <span className={className}>{children}</span>
  return (
    <a target="_blank" rel="noreferrer noopener" className={cn('inline-flex items-center gap-2', className)} {...props}>
      <ExternalLinkIcon aria-hidden className="size-4 shrink-0" />
      {children}
      <span className="sr-only"> Opens in your browser</span>
    </a>
  )
}
