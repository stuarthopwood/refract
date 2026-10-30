/** Open overlays (dialog, menu, select) that must suppress window-wide keyboard chords; Radix sets `role="dialog"` without `aria-modal`. */
export const OVERLAY_OPEN_SELECTOR = '[role="alertdialog"], [role="dialog"], [role="menu"], [data-slot="select-content"]'
