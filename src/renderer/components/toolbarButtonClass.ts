import { cn } from '@/lib/utils'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'

/** The one ghost icon-button treatment for a sidebar or panel toolbar (Session list, Outline):
 * muted at rest, sidebar-border hover fill, and a disabled state that dims only the glyph so the
 * focus ring keeps its contrast. The disabled resets are `dark`-prefixed because `.dark` is always
 * set regardless of the active theme (`globals.css`), so plain resets would lose on specificity. */
export const TOOLBAR_BUTTON_CLASS = cn(
  'text-muted-foreground hover:bg-sidebar-border hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:[&_svg]:opacity-50 dark:hover:bg-sidebar-border dark:aria-disabled:hover:bg-transparent aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground',
  COMPOSER_BUTTON_FOCUS_CLASS
)
