// One selected-tab treatment shared by the right-pane tab bar, the Pull requests filter and detail
// tabs, and the Ask card tabs: a muted fill, white text and a 2px accent underline bar. It keys off
// `aria-selected` alone (Radix Tabs and the hand-rolled right-pane tabs both set it; Tooltip's own
// `data-state` can clobber Tabs' on a shared node). Forced-colors mode swaps the bar for a
// `Highlight` border, since a pseudo-element fill is dropped there.
export const TAB_ACTIVE_UNDERLINE_CLASS =
  'relative aria-selected:bg-muted aria-selected:text-foreground aria-selected:shadow-none aria-selected:after:absolute aria-selected:after:inset-x-2 aria-selected:after:bottom-0 aria-selected:after:h-0.5 aria-selected:after:rounded-sm aria-selected:after:bg-accent-text forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight] forced-colors:aria-selected:after:hidden'
