// Spec 035 (WP-E): the three persisted text-size scales. Mirrors `src-tauri/src/store/typography.rs`.
export interface Typography {
  appScale: number;
  chatScale: number;
  codeScale: number;
}

export const TYPOGRAPHY_MIN_SCALE = 0.8;
export const TYPOGRAPHY_MAX_SCALE = 1.5;
export const DEFAULT_TYPOGRAPHY: Typography = { appScale: 1, chatScale: 1, codeScale: 1 };
