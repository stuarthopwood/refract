import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A real heading for the group below it, styled as the list's quiet section label. */
export function SectionHeading({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn('px-2 text-xs font-medium text-muted-foreground', className)}>{children}</h2>
}
