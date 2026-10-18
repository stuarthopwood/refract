// `ThemeId` extracted out of `settings.rs` (issue #551 gate round 1, #806 file-size ratchet:
// settings.rs sat exactly at the 600-line soft cap, so even rustfmt's mandatory one-variant-
// per-line layout for the two new #551 variants would have pushed it over) -- a pure-data,
// behaviour-preserving move, same pattern #564 used for `theme-contrast-pairs.mjs` and this
// story's own `mermaidThemeData.ts` split. Re-exported from `settings.rs` as `pub use
// super::theme_id::ThemeId;` so every existing caller (`ipc/theme.rs`, `settings.rs` itself)
// keeps importing it from `crate::store::settings::ThemeId`, unchanged.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeId {
    Dark,
    DarkHighContrast,
    Obsidian,
    // #551: additive, matches `src/shared/themes.ts`'s `ThemeId` union.
    NordicFrost,
    CyberAmber,
}
