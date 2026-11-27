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
    // Additive (#2171): shipped in the renderer by #2086 without this variant, so `theme.set` rejected it.
    AmberObsidian,
}

#[cfg(test)]
mod tests {
    use super::ThemeId;
    use serde_json::Value;

    const THEMES_TS: &str = include_str!("../../../src/shared/themes.ts");

    /// Ids of the `ThemeId` union in `src/shared/themes.ts`, read from the source so the test cannot drift from it.
    fn ts_theme_ids() -> Vec<String> {
        let src = THEMES_TS.replace("\r\n", "\n");
        let union = &src[src.find("export type ThemeId").expect("ThemeId union in themes.ts")..];
        let union = &union[..union.find("\n\n").expect("blank line ending the union")];
        // Quoted ids sit at the odd positions when splitting on `'`.
        union.split('\'').skip(1).step_by(2).map(str::to_string).collect()
    }

    #[test]
    fn every_theme_id_in_themes_ts_parses_as_a_theme_id() {
        let ids = ts_theme_ids();
        assert!(ids.len() >= 12, "parsed only {} ids from themes.ts", ids.len());
        for id in ids {
            let parsed: Result<ThemeId, _> = serde_json::from_value(Value::String(id.clone()));
            assert!(parsed.is_ok(), "themes.ts id {id:?} is missing from the Rust ThemeId enum");
        }
    }

    #[test]
    fn amber_obsidian_round_trips_as_its_kebab_case_id() {
        let value = serde_json::to_value(ThemeId::AmberObsidian).unwrap();
        assert_eq!(value, Value::String("amber-obsidian".to_string()));
        assert_eq!(serde_json::from_value::<ThemeId>(value).unwrap(), ThemeId::AmberObsidian);
    }
}
