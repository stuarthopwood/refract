import { cn } from '@/lib/utils'

/** Focus ring for `badgeVariants`-based triggers, which already draw an outline once a width utility is applied. */
export const COMPOSER_FOCUS_CLASS = 'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
export const COMPOSER_BUTTON_FOCUS_CLASS = cn(COMPOSER_FOCUS_CLASS, 'focus-visible:border-transparent focus-visible:outline-solid')
