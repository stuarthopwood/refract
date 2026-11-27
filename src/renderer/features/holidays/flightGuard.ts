// Motion (OS setting or Settings > Appearance > Reduce motion, #566) is `isMotionReduced()`; forced colours and reduced
// transparency are separate media queries the CSS hides the layer under (#1377), so the scheduler must not fly under them either.
export const DECORATION_SUPPRESSED_QUERY = '(forced-colors: active), (prefers-reduced-transparency: reduce)'

/** The scheduler flies no piece while this is true; `motionReduced` is `isMotionReduced()`. */
export function flightsSuppressed(motionReduced: boolean, decorationSuppressed: boolean): boolean {
  return motionReduced || decorationSuppressed
}
