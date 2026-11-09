// Read-only view of the pre-#1767 `token-guard.json` store, kept only for the one-time migration
// to the global omp config and as the launch fallback until that migration has succeeded.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use super::values::{self, ValueMap};
use crate::store::atomic_json::read_json_file;

pub const FILE_NAME: &str = "token-guard.json";
/// Version at which thresholds became percents; older stores drop their token thresholds.
const PERCENT_STORE_VERSION: u32 = 2;
/// Token thresholds the version 1 store held; the percent keys replaced them.
const LEGACY_THRESHOLD_KEYS: &[&str] =
    &["compaction.thresholdTokens", "compaction.modelThresholds"];

#[derive(Deserialize, Default)]
struct Stored {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    overrides: BTreeMap<String, Value>,
    #[serde(default)]
    read_limit_migrated: bool,
    #[serde(default)]
    soft_budget_migrated: bool,
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Drops values earlier builds stored as defaults (old 200-line read limit, old 80 budget) and v1 token thresholds.
fn drop_stale(stored: &mut Stored) {
    if !stored.read_limit_migrated && stored.overrides.get("read.defaultLimit") == Some(&json!(200))
    {
        stored.overrides.remove("read.defaultLimit");
    }
    if !stored.soft_budget_migrated
        && stored.overrides.get("task.softRequestBudget") == Some(&json!(80))
    {
        stored.overrides.remove("task.softRequestBudget");
    }
    if stored.version < PERCENT_STORE_VERSION {
        for key in LEGACY_THRESHOLD_KEYS {
            stored.overrides.remove(*key);
        }
    }
}

/// The user's valid choices from `token-guard.json`; empty when the file is absent or unreadable.
pub async fn overrides(dir: &Path) -> ValueMap {
    let mut stored: Stored = read_json_file(&path(dir), Stored::default)
        .await
        .unwrap_or_default();
    drop_stale(&mut stored);
    stored
        .overrides
        .into_iter()
        .filter(|(key, value)| values::validate(key, value).is_ok())
        .collect()
}

/// Defaults overlaid by the user's stored choices: what the old overlay sent.
pub async fn effective(dir: &Path) -> ValueMap {
    let mut all = values::defaults();
    all.extend(overrides(dir).await);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_stale_defaults_and_v1_thresholds() {
        let mut stored = Stored::default();
        stored
            .overrides
            .insert("task.softRequestBudget".into(), json!(80));
        stored
            .overrides
            .insert("read.defaultLimit".into(), json!(200));
        stored
            .overrides
            .insert("compaction.modelThresholds".into(), json!({ "a/b": 1 }));
        stored
            .overrides
            .insert("task.maxConcurrency".into(), json!(3));
        drop_stale(&mut stored);
        assert_eq!(stored.overrides.len(), 1);
        assert_eq!(stored.overrides["task.maxConcurrency"], json!(3));
    }
}
