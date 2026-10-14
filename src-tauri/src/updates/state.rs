// Port of `src/main/store/updateState.ts` (lane R11b, issue #794): holds `updateState.json`,
// specs/006-installer-and-updates/data-model.md's "UpdateState" entity -- the spec.md Key Entity
// "Update" (notified -> downloaded and checksum-verified -> installed), persisted so it survives
// a crash or an unexpected shutdown between steps (Edge Cases: "resumes the next time Refract
// quits"). Same atomic-write helper (`store::atomic_json`) and per-field-patch discipline as
// `registry.json`/`settings.json`.
//
// data-model.md's own phase-transition table, reproduced here since every caller
// (`updates::checker`, the not-yet-landed installer/quit modules) must respect it when it calls
// `update`:
//
// ```
// idle --check()--> checking --(no update)--> idle
//                            --(update found)--> available
//                            --(gh unavailable/offline)--> idle, unavailableReason set
// available --install()--> downloading --(checksum ok)--> downloaded
//                                       --(checksum fails / download fails)--> failed
// downloaded --(before-quit, normal quit)--> installing
// installing --(next app start, version matches)--> idle
//            --(next app start, version does not match)--> failed
// failed --check()--> checking (retrying is always available; failed is not a dead end)
// ```
//
// Quality-gate remediation (Medium "UpdateStateStore.open has no shape validation", ported from
// `updateState.ts`'s own header comment): the TS port hand-wrote `isValidUpdateState` because
// `readJsonFile<T>`'s generic cast trusts whatever JSON happens to parse. `serde`'s
// `Deserialize` derive already performs that same rejection structurally -- an unknown `phase`
// or `unavailableReason` string, or a wrong-shaped field, fails to parse as `UpdateState` and
// `store::atomic_json::read_json_file` already quarantines and falls back to the default on any
// parse failure -- so this port has no second manual validator to write or keep in sync.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::store::atomic_json::{read_json_file, write_json_file};

/// data-model.md's `phase` column (default `'idle'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Downloaded,
    Installing,
    Failed,
}

/// data-model.md's `unavailableReason` column: set instead of advancing past `'checking'` when
/// GitHub access is unavailable (FR-017); cleared on the next check that can actually reach
/// GitHub.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    NotInstalled,
    NotSignedIn,
    Offline,
}

/// data-model.md's "UpdateState (persisted: `updateState.json`, `src/main/store/updateState.ts`)"
/// table, field for field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// Schema version, matching `registry.json`/`settings.json`'s own `version: 1` convention.
    /// Always `1` in this build; `UpdateStateStore::update` re-asserts it on every write so a
    /// caller's patch closure can never accidentally change it.
    pub version: u32,
    pub phase: UpdatePhase,
    /// Set once `phase` reaches `'available'`; the `Release.version` found by `UpdateChecker`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    /// Set alongside `available_version` (FR-013).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes_url: Option<String>,
    /// Set once `phase` reaches `'downloaded'`: the verified installer's path under
    /// `app.getPath('userData')/updates/`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_path: Option<String>,
    /// ISO timestamp, updated on every `check()` call, successful or not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    /// Set on `phase: 'failed'`: an actionable reason (FR-018); cleared on the next successful
    /// phase transition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Set instead of advancing past `'checking'` when GitHub access is unavailable (FR-017).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<UnavailableReason>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            version: 1,
            phase: UpdatePhase::Idle,
            available_version: None,
            notes_url: None,
            installer_path: None,
            last_checked_at: None,
            last_error: None,
            unavailable_reason: None,
        }
    }
}

/// Holds `updateState.json` and the current in-memory `UpdateState`, the same shape every other
/// `*Store` in `src-tauri/src/store` uses: `open` reads once at startup, every subsequent
/// mutation goes through `update` so the on-disk file and the in-memory value never drift apart.
pub struct UpdateStateStore {
    file: PathBuf,
    data: UpdateState,
}

impl UpdateStateStore {
    /// Reads `<dir>/updateState.json`, falling back to `UpdateState::default()` for a missing or
    /// unparseable file (`store::atomic_json::read_json_file`'s own quarantine-and-default
    /// behaviour, which already covers an unknown `phase`/`unavailableReason` string via
    /// `UpdateState`'s `Deserialize` derive -- see this file's header comment). Never panics,
    /// never blocks launch.
    pub async fn open(dir: &Path) -> Self {
        let file = dir.join("updateState.json");
        let data = read_json_file::<UpdateState, _>(&file, UpdateState::default)
            .await
            .unwrap_or_default();
        Self { file, data }
    }

    /// Returns a clone of the current in-memory state.
    pub fn get(&self) -> UpdateState {
        self.data.clone()
    }

    /// Applies `mutate` to a clone of the current state, forces `version` back to `1` (so a
    /// caller's patch closure can never drift the schema version), persists the result, and
    /// stores it as the new current state. A write failure is logged, never propagated or
    /// panicked on -- matches `updateState.ts`'s own `update()`, which never let a disk error
    /// stop the in-memory state (and every caller awaiting it) from advancing.
    pub async fn update(&mut self, mutate: impl FnOnce(&mut UpdateState)) -> UpdateState {
        let mut next = self.data.clone();
        mutate(&mut next);
        next.version = 1;
        if let Err(err) = write_json_file(&self.file, &next).await {
            log::error!("UpdateStateStore: failed to write updateState.json: {err}");
        }
        self.data = next.clone();
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_available_state_uses_camel_case_field_names() {
        let state = UpdateState {
            version: 1,
            phase: UpdatePhase::Available,
            available_version: Some("1.4.0".to_string()),
            notes_url: Some(
                "https://github.com/stuarthopwood/refract/releases/tag/v1.4.0".to_string(),
            ),
            installer_path: None,
            last_checked_at: Some("2026-10-14T00:00:00.000Z".to_string()),
            last_error: None,
            unavailable_reason: None,
        };

        let json = serde_json::to_string(&state).expect("serialize");
        assert!(json.contains("\"availableVersion\":\"1.4.0\""));
        assert!(json.contains("\"notesUrl\":"));
        assert!(json.contains("\"lastCheckedAt\":"));
        assert!(!json.contains("installerPath"));
        assert!(!json.contains("lastError"));
        assert!(!json.contains("unavailableReason"));
        assert!(json.contains("\"phase\":\"available\""));

        let round_tripped: UpdateState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(round_tripped.phase, UpdatePhase::Available);
        assert_eq!(round_tripped.available_version.as_deref(), Some("1.4.0"));
    }

    #[test]
    fn round_trip_failed_state_with_last_error() {
        let state = UpdateState {
            version: 1,
            phase: UpdatePhase::Failed,
            available_version: None,
            notes_url: None,
            installer_path: None,
            last_checked_at: Some("2026-10-14T00:05:00.000Z".to_string()),
            last_error: Some("checksum mismatch".to_string()),
            unavailable_reason: None,
        };

        let json = serde_json::to_string(&state).expect("serialize");
        assert!(json.contains("\"phase\":\"failed\""));
        assert!(json.contains("\"lastError\":\"checksum mismatch\""));

        let round_tripped: UpdateState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(round_tripped.phase, UpdatePhase::Failed);
        assert_eq!(
            round_tripped.last_error.as_deref(),
            Some("checksum mismatch")
        );
    }

    #[test]
    fn round_trip_idle_state_with_unavailable_reason() {
        let state = UpdateState {
            unavailable_reason: Some(UnavailableReason::NotSignedIn),
            last_checked_at: Some("2026-10-14T00:10:00.000Z".to_string()),
            ..UpdateState::default()
        };

        let json = serde_json::to_string(&state).expect("serialize");
        assert!(json.contains("\"unavailableReason\":\"not-signed-in\""));

        let round_tripped: UpdateState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            round_tripped.unavailable_reason,
            Some(UnavailableReason::NotSignedIn)
        );
    }

    #[tokio::test]
    async fn open_falls_back_to_default_on_malformed_file() {
        let dir = std::env::temp_dir().join(format!(
            "refract-tauri-updatestate-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create temp dir");
        tokio::fs::write(dir.join("updateState.json"), b"{ not json at all")
            .await
            .expect("write malformed file");

        let store = UpdateStateStore::open(&dir).await;
        let state = store.get();
        assert_eq!(state.version, 1);
        assert_eq!(state.phase, UpdatePhase::Idle);
        assert!(state.available_version.is_none());

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
