/** The sidebar's full-row ghost button (GitHub nav entries, the Add project footer trigger):
 * left-aligned, 32px tall, sidebar-accent hover fill. The `dark:` twin is needed because `.dark` is
 * set for every dark-toned theme (`theme-store.ts`) and its variants would otherwise win. */
export const SIDEBAR_NAV_BUTTON_CLASS =
  'h-8 justify-start gap-2 px-2 text-sm hover:bg-sidebar-accent dark:hover:bg-sidebar-accent'
