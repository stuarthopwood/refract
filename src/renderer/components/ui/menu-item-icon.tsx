import type { LucideIcon } from "lucide-react"

/** Leading 16px icon for a menu item (#1405). Colour comes from `MENU_ICON_CLASS` on the item. In a menu where some items have no icon, pass `inset` to those so labels still align. */
export function MenuItemIcon({ icon: Icon }: { icon?: LucideIcon }) {
  return Icon ? <Icon aria-hidden className="size-4 shrink-0" /> : null
}
