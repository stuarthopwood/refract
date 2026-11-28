import type { ComponentProps } from 'react'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { TAB_LOOK_CLASS } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const TAB_CLASS = 'inline-flex h-6 items-center gap-1 px-2 text-sm font-medium'

export interface TabButtonProps extends ComponentProps<'button'> {
  /** The tab's own id and the panel it controls, or `null` when the tab has no panel of its own. */
  ids: { tabId: string; panelId: string } | null
  selected: boolean
}

/** The one raw tab button: every tab strip shares its roving tabindex, ARIA wiring and middle-click guard. */
export function TabButton({ ids, selected, className, onMouseDown, ...props }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      id={ids?.tabId}
      aria-selected={selected}
      aria-controls={selected ? ids?.panelId : undefined}
      {...props}
      tabIndex={selected ? 0 : -1}
      className={cn(TAB_CLASS, className, INSET_FOCUS_OUTLINE_CLASS, TAB_LOOK_CLASS)}
      onMouseDown={(event) => {
        // Stops the browser's middle-click autoscroll so the aux click can close the tab.
        if (event.button === 1) event.preventDefault()
        onMouseDown?.(event)
      }}
    />
  )
}
