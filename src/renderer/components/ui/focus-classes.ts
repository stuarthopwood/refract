// Inset outline for controls that sit flush against a clipping edge; the forced-colors offset must be
// restated because the base Button sets its own.
export const INSET_FOCUS_OUTLINE_CLASS =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring forced-colors:focus-visible:outline-offset-[-2px]'

// Programmatic focus target for a finished card (tabIndex -1), so Submit or Esc never leaves focus on the page body;
// the ring shows only for keyboard-driven focus, and `focus-visible:outline-hidden` supplies the forced-colors
// outline that replaces the box-shadow ring Windows high contrast drops.
export const RESTING_FOCUS_CLASS =
  'outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
