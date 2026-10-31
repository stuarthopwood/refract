// One item look shared by `dropdown-menu.tsx` and `context-menu.tsx` so they can't drift (#1124).
// A 2px inset bar marks the focused row; Radix focuses on pointer hover, so it paints on hover too.
// Forced colours drop the bar and fill, so focus gets a `Highlight` outline (#1065). An icon with its own `text-*` class is left alone.
const MENU_ICON_CLASS =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground hover:[&_svg:not([class*='text-'])]:text-current focus:[&_svg:not([class*='text-'])]:text-current data-[variant=destructive]:[&_svg:not([class*='text-'])]:text-destructive"

export const MENU_ITEM_CLASS = `relative flex w-full cursor-default items-center gap-2 px-2 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:shadow-[inset_2px_0_0_0_var(--color-active-indicator)] forced-colors:focus:outline-2 forced-colors:focus:outline-solid forced-colors:focus:outline-offset-[-2px] forced-colors:focus:outline-[color:Highlight] data-disabled:pointer-events-none data-disabled:opacity-50 aria-disabled:forced-colors:text-[GrayText] data-[inset=true]:pl-8 ${MENU_ICON_CLASS}`

export const MENU_ITEM_DESTRUCTIVE_CLASS =
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:focus:shadow-[inset_2px_0_0_0_var(--color-destructive)]"

export const MENU_SUB_TRIGGER_CLASS = `${MENU_ITEM_CLASS} data-[state=open]:bg-accent data-[state=open]:text-accent-foreground`

// Shared boxes so a dropdown and a context menu render identically.
const MENU_BOX_CLASS =
  "duration-[var(--motion-fast)] ease-[var(--ease-out)] z-50 min-w-40 overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground ring-1 ring-elevated-edge data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"

export const MENU_CONTENT_CLASS = `${MENU_BOX_CLASS} shadow-md`

export const MENU_SUB_CONTENT_CLASS = `${MENU_BOX_CLASS} shadow-lg`

export const MENU_LABEL_CLASS = "px-2 py-1 text-xs text-muted-foreground data-[inset=true]:pl-8"

export const MENU_SEPARATOR_CLASS = "pointer-events-none -mx-1 my-1 h-px bg-border"
