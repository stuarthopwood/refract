// `ThemeId`, split from `settings.rs` for the size cap (#806); re-exported there.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeId {
    Dark,
    DarkHighContrast,
    Obsidian,
    // Additive (#551).
    NordicFrost,
    CyberAmber,
    // Additive (#1590).
    Light,
    LightWarmPaper,
    LightHighContrast,
    Lagoon,
    Amethyst,
    Hearth,
}
