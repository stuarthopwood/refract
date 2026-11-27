// Inset outline for controls that sit flush against a clipping edge; the forced-colors offset must be
// restated because the base Button sets its own.
export const INSET_FOCUS_OUTLINE_CLASS =
  'focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring forced-colors:focus-visible:outline-offset-[-2px]'

// Focus target for a finished card (tabIndex -1), so Submit or Esc never strands focus on the body;
// `outline-hidden` gives forced colors an outline in place of the box-shadow ring high contrast drops.
export const RESTING_FOCUS_CLASS =
  'outline-none focus-visible:outline-hidden focus-visible:ring-(length:--focus-ring-width) focus-visible:ring-ring'
