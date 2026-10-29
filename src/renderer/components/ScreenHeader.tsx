// Shared full-screen header (#934, docs/design/components.md "Reusable components first"): the
// drag-region title band with a Back button, the focusable heading, an optional plain muted
// count line, and trailing actions. First used by Manage sessions; the Settings and Pull requests
// screens adopt it one group per PR (#935).
import type { ReactNode, Ref } from 'react'
import { ArrowLeftIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface ScreenHeaderProps {
  title: string
  /** Moved to on mount by the caller so focus never drops to `<body>` when the screen swaps in. */
  headingRef?: Ref<HTMLHeadingElement>
  backLabel: string
  onBack(): void
  /** Plain muted text beside the heading, for example "5 sessions across 4 projects". */
  count?: string
  /** Right-aligned actions. */
  children?: ReactNode
}

export function ScreenHeader({ title, headingRef, backLabel, onBack, count, children }: ScreenHeaderProps) {
  return (
    <div className="drag-region titlebar-surface flex h-10 shrink-0 items-center gap-2 px-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="no-drag-region" aria-label={backLabel} onClick={onBack}>
            <ArrowLeftIcon aria-hidden className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{backLabel}</TooltipContent>
      </Tooltip>
      <h1 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
        {title}
      </h1>
      {count && <span className="truncate text-xs text-muted-foreground">{count}</span>}
      {children && <div className="no-drag-region ml-auto flex items-center gap-2">{children}</div>}
    </div>
  )
}
