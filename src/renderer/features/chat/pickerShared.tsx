import { useEffect, useState } from 'react'
import { badgeVariants } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Shared by both pickers: blocks only an attempt to open while `disabled`, and force-closes an already-open menu. */
export function usePickerOpenState(disabled: boolean) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  function onOpenChange(next: boolean) {
    if (next && disabled) return
    setOpen(next)
  }
  return { open, setOpen, onOpenChange }
}

/** Focus ring for `badgeVariants`-based triggers, which already draw an outline once a width utility is applied. */
export const COMPOSER_FOCUS_CLASS = 'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
export const COMPOSER_BUTTON_FOCUS_CLASS = cn(COMPOSER_FOCUS_CLASS, 'focus-visible:border-transparent focus-visible:outline-solid')

/** Focus is never invisible, only muted. */
export const GHOST_FOCUS_CLASS = 'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-composer-focus focus-visible:border-transparent'
export const GHOST_BUTTON_FOCUS_CLASS = cn(GHOST_FOCUS_CLASS, 'focus-visible:outline-solid')

/** One shared opacity value, applied unconditionally wherever `aria-disabled` is the only disabled signal (no separate native `disabled` attribute). */
export const COMPOSER_DISABLED_OPACITY_CLASS = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 focus-visible:aria-disabled:opacity-100'
export const COMPOSER_DISABLED_HOVER_RESET_CLASS = 'aria-disabled:hover:bg-transparent aria-disabled:hover:text-current'
export const COMPOSER_DISABLED_CLASS = cn(COMPOSER_DISABLED_OPACITY_CLASS, COMPOSER_DISABLED_HOVER_RESET_CLASS)

export const PICKER_TRIGGER_CLASS = cn(
  badgeVariants({ variant: 'ghost' }),
  'h-6 shrink-0 gap-2 px-2 border border-composer-control-border cursor-pointer aria-disabled:cursor-not-allowed text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:aria-disabled:hover:bg-transparent',
  COMPOSER_DISABLED_CLASS,
  GHOST_FOCUS_CLASS
)

/** The keyboard-active option highlight. */
export const PICKER_OPTION_CLASS = 'flex cursor-default items-center gap-2 border-l-2 border-transparent px-2 py-1 text-sm'
export const PICKER_OPTION_ACTIVE_CLASS = 'border-l-active-indicator bg-accent text-accent-foreground'

/** The composer's own surface/border/focus treatment. */
export const COMPOSER_INPUT_SURFACE_CLASS =
  'border-composer-border bg-composer-background dark:bg-composer-background focus-visible:border-composer-focus focus-visible:ring-3 focus-visible:ring-composer-ring'
