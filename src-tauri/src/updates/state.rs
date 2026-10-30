// Persists `updateState.json` so an update survives a crash mid-install.
// Serde rejects unknown phases; `read_json_file` then falls back to the default.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::store::atomic_json::{read_json_file, write_json_file};

/// The one store for the process lifetime, locked per transition, never across a network call.
pub type SharedUpdateState = Arc<AsyncMutex<UpdateStateStore>>;

/// The `phase` column; defaults to `idle`.
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

/// Why an update check could not reach GitHub.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnavailableReason {
    NotInstalled,
    NotSignedIn,
    Offline,
}

/// Persisted `updateState.json` shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// Always `1`; `UpdateStateStore::update` re-asserts it on every write.
    pub version: u32,
    pub phase: UpdatePhase,
    /// Set once `phase` reaches `available`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    /// Set alongside `available_version`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes_url: Option<String>,
    /// Set once `phase` reaches `downloaded`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_path: Option<String>,
    /// ISO timestamp, updated on every `check()` call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    /// Set on `phase: failed`; cleared on the next successful transition.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Set instead of advancing past `checking` when GitHub is unreachable.
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

/// Holds `updateState.json` and the in-memory state; every mutation goes through `update`.
pub struct UpdateStateStore {
    file: PathBuf,
    data: UpdateState,
}

impl UpdateStateStore {
    /// Reads `<dir>/updateState.json`, falling back to the default on a missing or bad file.
    /// Never panics, never blocks launch.
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

    /// Applies `mutate`, pins `version` to `1`, persists, then stores the result. A write
    /// failure is logged, never propagated, so in-memory state still advances.
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
