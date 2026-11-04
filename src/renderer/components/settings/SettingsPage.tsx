// A Settings page (CONTEXT.md "Settings page"): the `h2` heading (focused on mount, so a section
// change lands somewhere meaningful), an optional intro, and a left-aligned column capped at
// `max-w-2xl` (`max-w-3xl` for Models) holding the page's `SettingsGroup`s. Omit `title` to wrap a
// section that still draws its own heading.
import { useEffect, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { cn } from '@/lib/utils'

interface SettingsPageProps {
  title?: string
  intro?: ReactNode
  width?: 'default' | 'wide'
  /** Lets a section that moves focus back to the heading (Appearance) share this one. */
  headingRef?: RefObject<HTMLHeadingElement | null>
  className?: string
  /** A page-level action (one primary button) shown at the right of the heading. */
  actions?: ReactNode
  children: ReactNode
}

export function SettingsPage({ title, intro, width = 'default', headingRef, className, actions, children }: SettingsPageProps) {
  const ownRef = useRef<HTMLHeadingElement>(null)
  const ref = headingRef ?? ownRef
  useEffect(() => {
    ref.current?.focus()
  }, [ref])
  return (
    <div className={cn('flex w-full flex-col', width === 'wide' ? 'max-w-3xl' : 'max-w-2xl', className)}>
      {title && (
        <div className="mb-1 flex items-start justify-between gap-4">
          <h2 ref={ref} tabIndex={-1} className="text-base font-semibold outline-none">
            {title}
          </h2>
          {actions}
        </div>
      )}
      {intro && <p className="mb-4 text-sm text-muted-foreground">{intro}</p>}
      {children}
    </div>
  )
}
