// Shared by every window-wide keyboard chord in App.tsx (Ctrl+Shift+\, Ctrl+W, Ctrl+,): a
// destructive- or navigation-feeling chord must not fire while a Dialog/Sheet (`role="dialog"`, which Radix
// sets despite the primitive never setting `aria-modal` -- confirmed in its installed
// source, so matching the bare role is both correct and simpler), an AlertDialog
// (`role="alertdialog"`), a DropdownMenu/ContextMenu (`role="menu"`), or a Select
// (`data-slot="select-content"`, which sets no distinguishing role at all) is open. Radix
// Popover also renders `role="dialog"` despite being non-modal, so it needs no separate
// `data-slot` clause either (quality-gate remediation, PR #634/#636 gates).
export const OVERLAY_OPEN_SELECTOR = '[role="alertdialog"], [role="dialog"], [role="menu"], [data-slot="select-content"]'
