// Update download, checksum verification (spec 006 FR-014, research.md decision 4): downloads
// the available release's installer and checksum assets via `gh release download` (the
// developer's own signed-in credential, never a stored token), recomputes the installer's
// SHA-256 with the `sha2` crate, and only persists `phase: Downloaded` on a match. Ported from
// `src/main/update/UpdateInstaller.ts`'s `downloadUpdate`/`UpdateError` (git show
// origin/spec-006-impl:src/main/update/UpdateInstaller.ts).

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::gh_client::gh_raw;
use super::state::{UpdatePhase, UpdateStateStore};

/// research.md decision 8: the same private repository `UpdateChecker`/`gh_client` reads from.
const REPO: &str = "stuarthopwood/refract";

/// `updates.install()`'s two documented errors (contracts/ipc.md): any failure past the
/// `Available` precondition check (a network failure, a missing asset, or a real digest
/// mismatch) is reported as `ChecksumMismatch` -- the contract defines no finer-grained code for
/// this one call; `UpdateState.last_error` (via `updates:state-changed`/`getState`) still carries
/// the specific, actionable reason for the badge UI.
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

/// `updates.install()` (contracts/ipc.md): awaits the whole download and checksum verification
/// for the release named by the current `Available` state before resolving; persists
/// `Downloading` immediately (so `updates:state-changed` can drive a progress indicator before
/// this future ever resolves), then `Downloaded` with `installer_path` set on a verified match,
/// or `Failed` with `last_error` otherwise (FR-014).
pub async fn download_update(
    store: &mut UpdateStateStore,
    data_dir: &Path,
) -> Result<(), UpdateError> {
    let state = store.get();
    if state.phase != UpdatePhase::Available || state.available_version.is_none() {
        return Err(UpdateError::new(
            UpdateErrorCode::UpdateUnavailable,
            "No update is available to install.",
        ));
    }
    // Safe: checked non-None immediately above.
    let tag_name = format!("v{}", state.available_version.unwrap());

    store.update(|s| s.phase = UpdatePhase::Downloading).await;

    match try_download(data_dir, &tag_name).await {
        Ok(installer_path) => {
            store
                .update(|s| {
                    s.phase = UpdatePhase::Downloaded;
                    s.installer_path = Some(installer_path);
                    s.last_error = None;
                })
                .await;
            Ok(())
        }
        Err(detail) => {
            store
                .update(|s| {
                    s.phase = UpdatePhase::Failed;
                    s.last_error = Some(detail.clone());
                })
                .await;
            Err(UpdateError::new(UpdateErrorCode::ChecksumMismatch, detail))
        }
    }
}

/// The whole download-and-verify body, factored out of `download_update` so every exit path
/// (missing asset, `gh` failure, a real digest mismatch) collapses to the single `Err(String)`
/// `download_update` reports as `ChecksumMismatch`, matching `UpdateInstaller.ts`'s own single
/// `catch` block.
async fn try_download(data_dir: &Path, tag_name: &str) -> Result<String, String> {
    let updates_dir = data_dir.join("updates");
    // A previous failed attempt's leftovers are never mistaken for this one's fresh pair --
    // `updates_dir` is always `<data_dir>/updates`, never a caller-supplied or empty path.
    match tokio::fs::remove_dir_all(&updates_dir).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.to_string()),
    }
    tokio::fs::create_dir_all(&updates_dir)
        .await
        .map_err(|err| err.to_string())?;

    // Quality-gate remediation (HIGH, ported verbatim): `gh_raw`'s default timeout exists for
    // ordinary metadata calls -- the installer this downloads is ~146MB, which needs far longer
    // than that on anything but a very fast connection; this is the one caller that opts into
    // several minutes instead.
    const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
    let updates_dir_str = updates_dir.to_string_lossy().into_owned();
    let result = gh_raw(
        data_dir,
        &[
            "release",
            "download",
            tag_name,
            "--repo",
            REPO,
            "--pattern",
            "*.exe",
            "--pattern",
            "*.sha256",
            "--dir",
            &updates_dir_str,
            "--clobber",
        ],
        DOWNLOAD_TIMEOUT,
    )
    .await?;

    if result.code != 0 {
        let detail = if !result.stderr.trim().is_empty() {
            result.stderr.trim()
        } else if !result.stdout.trim().is_empty() {
            result.stdout.trim()
        } else {
            "gh release download failed."
        };
        return Err(detail.to_string());
    }

    let (installer_path, checksum_path) = find_downloaded_pair(&updates_dir).await?;

    let expected = tokio::fs::read_to_string(&checksum_path)
        .await
        .map_err(|err| err.to_string())?
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();

    let installer_bytes = tokio::fs::read(&installer_path)
        .await
        .map_err(|err| err.to_string())?;
    let actual = hex_digest(&installer_bytes);

    if !checksum_matches(&actual, &expected) {
        // Both paths are always children of `updates_dir` (`<data_dir>/updates`), never derived
        // from caller input.
        let _ = tokio::fs::remove_file(&installer_path).await;
        let _ = tokio::fs::remove_file(&checksum_path).await;
        return Err("The downloaded installer did not match its published checksum.".to_string());
    }

    Ok(installer_path.to_string_lossy().into_owned())
}

/// Scans `updates_dir` (just populated by `gh release download --clobber`) for its one `.exe`
/// and one `.sha256` entry, case-insensitively, matching `UpdateInstaller.ts`'s own
/// `entries.find(...)` pair lookup.
async fn find_downloaded_pair(updates_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut installer_path: Option<PathBuf> = None;
    let mut checksum_path: Option<PathBuf> = None;

    let mut entries = tokio::fs::read_dir(updates_dir)
        .await
        .map_err(|err| err.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|err| err.to_string())? {
        let path = entry.path();
        let lower = path.to_string_lossy().to_lowercase();
        if lower.ends_with(".exe") {
            installer_path = Some(path);
        } else if lower.ends_with(".sha256") {
            checksum_path = Some(path);
        }
    }

    match (installer_path, checksum_path) {
        (Some(installer), Some(checksum)) => Ok((installer, checksum)),
        _ => Err("The downloaded release is missing its installer or checksum file.".to_string()),
    }
}

/// Lower-case hex SHA-256 of `bytes`. A plain byte-to-hex fold rather than relying on
/// `GenericArray`'s own `LowerHex` impl, so this has no dependency on an undocumented trait bound
/// holding across `sha2` versions.
fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Factored out so it can be unit-tested without touching the filesystem: case-insensitive
/// comparison, treating an empty/missing `expected` value as never-matching (mirrors
/// `UpdateInstaller.ts`'s own `!expected || actual !== expected` check -- `actual` here is always
/// already-lower-case hex from `hex_digest`, so only `expected` needs case-insensitive handling).
fn checksum_matches(actual_hex: &str, expected: &str) -> bool {
    !expected.is_empty() && actual_hex.eq_ignore_ascii_case(expected)
}

#[cfg(test)]
mod tests {
    use super::checksum_matches;

    #[test]
    fn matches_case_insensitively() {
        assert!(checksum_matches("abc123", "ABC123"));
        assert!(checksum_matches("abc123", "abc123"));
    }

    #[test]
    fn rejects_digest_mismatch() {
        assert!(!checksum_matches("abc123", "def456"));
    }

    #[test]
    fn rejects_empty_expected() {
        assert!(!checksum_matches("abc123", ""));
    }
}
