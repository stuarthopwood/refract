import * as React from 'react'
import { cn } from '@/lib/utils'

// One look for every inline code chip: Markdown code spans and chat tool row targets share it so
// they cannot drift. `box-decoration-clone` keeps the fill and padding on every wrapped line.
export const INLINE_CODE_CLASS = 'rounded bg-md-code-bg px-1 py-1 font-code text-code-inline text-md-code-fg box-decoration-clone'

/** A monospace chip on the Markdown inline-code fill; `className` overrides sizing or text colour. */
export function InlineCode({ className, ...props }: React.ComponentProps<'code'>) {
  return <code data-slot="inline-code" className={cn(INLINE_CODE_CLASS, className)} {...props} />
}
