// Spec 035 (WP-E): the three persisted text-size scales. Mirrors `src-tauri/src/store/typography.rs`.
export interface Typography {
  appScale: number;
  chatScale: number;
  codeScale: number;
}

export const TYPOGRAPHY_MIN_SCALE = 0.8;
export const TYPOGRAPHY_MAX_SCALE = 1.5;
export const DEFAULT_TYPOGRAPHY: Typography = { appScale: 1, chatScale: 1, codeScale: 1 };

/** The body text step and the readable floor. `globals.css` mirrors the floor as `max(min(<step>, 11px), ...)` in the `--text-*` variables. */
export const TYPOGRAPHY_BODY_PX = 14;
export const TYPOGRAPHY_MIN_PX = 11;

/** The body size in px a scale gives (never under the 11px floor). */
export function scaledBodyPx(scale: number): number {
  return Math.max(TYPOGRAPHY_MIN_PX, TYPOGRAPHY_BODY_PX * scale);
}
