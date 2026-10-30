// The store lock is never held across the download.
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::github::gh::{gh_json, gh_raw, non_empty_or};

use super::checksum::{checksum_matches, hex_digest_file};
use super::dependency_install_http::safe_file_name;
use super::signature::verify_installer_signature;
use super::state::{SharedUpdateState, UpdatePhase, UpdateState};

const REPO: &str = "stuarthopwood/refract";

/// The installer is about 146 MB, so it needs longer than the metadata timeout.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Caps `gh` error text so unbounded output is never persisted or shown.
const MAX_ERROR_LEN: usize = 500;

fn cap_error(detail: impl Into<String>) -> String {
    let detail = detail.into();
    if detail.chars().count() > MAX_ERROR_LEN {
        let truncated: String = detail.chars().take(MAX_ERROR_LEN).collect();
        format!("{truncated}...")
    } else {
        detail
    }
}

#[derive(Deserialize)]
struct GhReleaseAsset {
    name: String,
}

#[derive(Deserialize)]
struct GhReleaseAssets {
    assets: Vec<GhReleaseAsset>,
}

/// Every post-`Available` failure reports as `ChecksumMismatch`; the reason is in `last_error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateErrorCode {
    UpdateUnavailable,
    ChecksumMismatch,
}

#[derive(Debug)]
pub struct UpdateError {
    pub code: UpdateErrorCode,
    pub message: String,
}

impl UpdateError {
    fn new(code: UpdateErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for UpdateError {}

/// Downloads and verifies the `Available` release, including its signature.
pub async fn download_update(
    store: &SharedUpdateState,
    data_dir: &Path,
    on_state: &(dyn Fn(&UpdateState) + Send + Sync),
) -> Result<(), UpdateError> {
    let tag_name = {
        let mut guard = store.lock().await;
        let state = guard.get();
        if state.phase != UpdatePhase::Available || state.available_version.is_none() {
            return Err(UpdateError::new(
                UpdateErrorCode::UpdateUnavailable,
                "No update is available to install.",
            ));
        }
        let tag_name = format!("v{}", state.available_version.unwrap());
        let downloading = guard.update(|s| s.phase = UpdatePhase::Downloading).await;
        drop(guard);
        on_state(&downloading);
        tag_name
    };

    let outcome = try_download(data_dir, &tag_name).await;

    let mut guard = store.lock().await;
    let committed = match &outcome {
        Ok(installer_path) => {
            guard
                .update(|s| {
                    s.phase = UpdatePhase::Downloaded;
                    s.installer_path = Some(installer_path.clone());
                    s.last_error = None;
                })
                .await
        }
        Err(detail) => {
            guard
                .update(|s| {
                    s.phase = UpdatePhase::Failed;
                    s.last_error = Some(detail.clone());
                })
                .await
        }
    };
    drop(guard);
    on_state(&committed);

    match outcome {
        Ok(_) => Ok(()),
        Err(detail) => Err(UpdateError::new(UpdateErrorCode::ChecksumMismatch, detail)),
    }
}

/// Runs with no lock held; every failure collapses to one `Err(String)`.
async fn try_download(data_dir: &Path, tag_name: &str) -> Result<String, String> {
    let updates_dir = data_dir.join("updates");
    match tokio::fs::remove_dir_all(&updates_dir).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.to_string()),
    }
    tokio::fs::create_dir_all(&updates_dir)
        .await
        .map_err(|err| err.to_string())?;

    let assets: GhReleaseAssets = gh_json(
        data_dir,
        &[
            "release", "view", tag_name, "--repo", REPO, "--json", "assets",
        ],
    )
    .await
    .map_err(|err| cap_error(err.to_string()))?;
    // Exactly one `.exe` is required; a glob would hide an ambiguous release.
    let exe_assets: Vec<&str> = assets
        .assets
        .iter()
        .map(|a| a.name.as_str())
        .filter(|name| name.to_lowercase().ends_with(".exe"))
        .collect();
    let installer_name = match exe_assets.as_slice() {
        [] => return Err("The release is missing an installer (.exe) asset.".to_string()),
        [single] => single.to_string(),
        _ => {
            return Err(format!(
                "The release has {} installer (.exe) assets; expected exactly one.",
                exe_assets.len()
            ))
        }
    };
    let checksum_name = format!("{installer_name}.sha256");
    if !assets
        .assets
        .iter()
        .any(|a| a.name.eq_ignore_ascii_case(&checksum_name))
    {
        return Err(format!(
            "The release is missing its checksum asset ({checksum_name})."
        ));
    }

    let updates_dir_str = updates_dir.to_string_lossy().into_owned();
    let download_args = [
        "release",
        "download",
        tag_name,
        "--repo",
        REPO,
        "--pattern",
        &installer_name,
        "--pattern",
        &checksum_name,
        "--dir",
        &updates_dir_str,
        "--clobber",
    ];
    let args_joined = download_args.join(" ");
    let result = gh_raw(data_dir, &download_args, None, DOWNLOAD_TIMEOUT)
        .await
        .map_err(|err| err.to_string())?;

    if result.timed_out {
        return Err("Download timed out.".to_string());
    }
    if result.code != 0 {
        let detail = non_empty_or(
            &result.stderr,
            &result.stdout,
            &format!("gh command failed: gh {args_joined}"),
        );
        return Err(cap_error(detail));
    }

    // Only the local path is sanitised; `--pattern` needs the raw API name.
    let installer_path = updates_dir.join(safe_file_name(&installer_name));
    let checksum_path = updates_dir.join(safe_file_name(&checksum_name));
    if !tokio::fs::try_exists(&installer_path)
        .await
        .unwrap_or(false)
        || !tokio::fs::try_exists(&checksum_path).await.unwrap_or(false)
    {
        return Err(
            "The downloaded release is missing its installer or checksum file.".to_string(),
        );
    }

    let expected = tokio::fs::read_to_string(&checksum_path)
        .await
        .map_err(|err| err.to_string())?
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();

    let actual = hex_digest_file(&installer_path).await?;

    if !checksum_matches(&actual, &expected) {
        let _ = tokio::fs::remove_file(&installer_path).await;
        let _ = tokio::fs::remove_file(&checksum_path).await;
        return Err("The downloaded installer did not match its published checksum.".to_string());
    }

    if let Err(reason) = verify_installer_signature(&installer_path).await {
        let _ = tokio::fs::remove_file(&installer_path).await;
        let _ = tokio::fs::remove_file(&checksum_path).await;
        return Err(reason);
    }

    Ok(installer_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_error_code_matches_contract() {
        let err = UpdateError::new(UpdateErrorCode::UpdateUnavailable, "no update");
        assert_eq!(err.code, UpdateErrorCode::UpdateUnavailable);
        assert_eq!(err.to_string(), "no update");
    }
}
