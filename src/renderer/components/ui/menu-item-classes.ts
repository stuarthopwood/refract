// Issue #1124: one item look shared by `dropdown-menu.tsx` and `context-menu.tsx` (items,
// sub-triggers, radio and checkbox items), so the two menu families cannot drift apart again.
// The 2px inset bar on focus is the active-row cue (`--active-indicator`); a destructive item
// keeps its own red cue. Icons rest at `text-muted-foreground` and go full strength (current
// text colour) on hover/focus; an icon with its own `text-*` class is left alone.
const MENU_ICON_CLASS =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-current focus:[&_svg:not([class*='text-'])]:text-current data-[variant=destructive]:[&_svg:not([class*='text-'])]:text-destructive"

export const MENU_ITEM_CLASS = `relative flex w-full cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:shadow-[inset_2px_0_0_0_var(--color-active-indicator)] data-disabled:pointer-events-none data-disabled:opacity-50 data-[inset=true]:pl-8 ${MENU_ICON_CLASS}`

export const MENU_ITEM_DESTRUCTIVE_CLASS =
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:focus:shadow-[inset_2px_0_0_0_var(--color-destructive)]"

export const MENU_SUB_TRIGGER_CLASS = `${MENU_ITEM_CLASS} data-[state=open]:bg-accent data-[state=open]:text-accent-foreground`
