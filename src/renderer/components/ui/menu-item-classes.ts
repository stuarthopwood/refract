// Issue #1124: one item look shared by `dropdown-menu.tsx` and `context-menu.tsx` (items,
// sub-triggers, radio and checkbox items), so the two menu families cannot drift apart again.
// The 2px inset bar on focus is the active-row cue (`--active-indicator`); a destructive item
// keeps its own red cue. Icons rest at `text-muted-foreground` and go full strength (current
// text colour) on hover/focus; an icon with its own `text-*` class is left alone. Forced colours
// drop the box-shadow bar and `bg-accent`, so a focused row gets a `Highlight` outline there (#1065).
// Radix moves real DOM focus on pointer hover, so the bar and fill paint on hover too, not only
// on keyboard navigation.
const MENU_ICON_CLASS =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-current focus:[&_svg:not([class*='text-'])]:text-current data-[variant=destructive]:[&_svg:not([class*='text-'])]:text-destructive"

export const MENU_ITEM_CLASS = `relative flex w-full cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:shadow-[inset_2px_0_0_0_var(--color-active-indicator)] forced-colors:focus:outline-2 forced-colors:focus:outline-solid forced-colors:focus:outline-offset-[-2px] forced-colors:focus:outline-[color:Highlight] data-disabled:pointer-events-none data-disabled:opacity-50 data-[inset=true]:pl-8 ${MENU_ICON_CLASS}`

export const MENU_ITEM_DESTRUCTIVE_CLASS =
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:focus:shadow-[inset_2px_0_0_0_var(--color-destructive)]"

export const MENU_SUB_TRIGGER_CLASS = `${MENU_ITEM_CLASS} data-[state=open]:bg-accent data-[state=open]:text-accent-foreground`

// Shared boxes, so a dropdown and a context menu render identically: one min-width, one ring
// (no border), one label size and one pointer-inert separator. Radix animation hooks are the same.
const MENU_BOX_CLASS =
  "duration-[var(--motion-fast)] ease-[var(--ease-out)] z-50 min-w-40 overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground ring-1 ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"

export const MENU_CONTENT_CLASS = `${MENU_BOX_CLASS} shadow-md`

export const MENU_SUB_CONTENT_CLASS = `${MENU_BOX_CLASS} shadow-lg`

export const MENU_LABEL_CLASS = "px-2 py-1 text-xs text-muted-foreground data-[inset=true]:pl-8"

export const MENU_SEPARATOR_CLASS = "pointer-events-none -mx-1 my-1 h-px bg-border"
