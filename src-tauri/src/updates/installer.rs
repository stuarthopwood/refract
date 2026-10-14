// Update download, checksum verification (spec 006 FR-014, research.md decision 4): downloads
// the available release's installer and checksum assets via `gh release download` (the
// developer's own signed-in credential, never a stored token), recomputes the installer's
// SHA-256, and only persists `phase: Downloaded` on a match. Ported from
// `src/main/update/UpdateInstaller.ts`'s `downloadUpdate`/`UpdateError` (git show
// origin/spec-006-impl:src/main/update/UpdateInstaller.ts).
//
// Gate findings (PR #829 round 1):
// - (perf HIGH) The store lock used to be held by the caller across the whole download (up to
//   5 minutes). Fixed the same way as `checker::check_for_updates`: takes the shared
//   `Arc<Mutex<_>>`, locks only to read the precondition and persist `Downloading` (broadcast via
//   `on_state`), downloads and hashes with NO lock held, then re-locks once to commit.
// - (security LOW) Downloaded only `*.exe`/`*.sha256` by glob, so a release with more than one
//   `.exe` asset would silently keep "whichever is listed last". Now looks up the release's own
//   asset list first, downloads the exact installer asset name and its exact `<name>.sha256`
//   sibling (matching `install_on_quit.rs`'s own `sha256_sibling` naming), never a glob.
// - (security LOW) Raw, uncapped `gh` stderr used to be saved to `last_error` as-is; now routed
//   through the shared, redacting `github::gh::non_empty_or` plus this file's own local length
//   cap, same as every other `gh` failure path.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::github::gh::{gh_json, gh_raw, non_empty_or};

use super::checksum::{checksum_matches, hex_digest_file};
use super::dependency_install_http::safe_file_name;
use super::state::{SharedUpdateState, UpdatePhase, UpdateState};

/// research.md decision 8: the same private repository `UpdateChecker`/`gh_client` reads from.
const REPO: &str = "stuarthopwood/refract";

/// Quality-gate remediation (HIGH, ported verbatim): the default metadata timeout exists for
/// ordinary small calls -- the installer this downloads is ~146MB, which needs far longer than
/// that on anything but a very fast connection; this is the one caller that opts into several
/// minutes instead.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Shared cap for any raw `gh` error text this module ever surfaces (release-view JSON errors
/// and the download path's own stderr/stdout pick alike) -- an unbounded `gh` response must
/// never persist/display in full.
const MAX_ERROR_LEN: usize = 500;

/// Truncates `detail` to `MAX_ERROR_LEN` chars, appending `...` when it was cut -- the one
/// shared helper both the `release view` error path and the download error path route through,
/// so the cap can never drift between the two.
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
/// `Downloading` immediately (so `updates:state-changed`, broadcast via `on_state`, can drive a
/// progress indicator before this future ever resolves), then `Downloaded` with
/// `installer_path` set on a verified match, or `Failed` with `last_error` otherwise (FR-014).
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
        // Safe: checked non-None immediately above.
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

/// The whole download-and-verify body, factored out of `download_update` so every exit path
/// (missing asset, `gh` failure, a real digest mismatch) collapses to the single `Err(String)`
/// `download_update` reports as `ChecksumMismatch`, matching `UpdateInstaller.ts`'s own single
/// `catch` block. Runs with NO store lock held.
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

    // Security fix (gate round 1, LOW): look up the release's own asset list first and download
    // the EXACT installer asset name plus its exact `<name>.sha256` sibling, never a `*.exe`
    // glob -- a release with more than one `.exe` asset used to silently keep "whichever is
    // listed last" instead of failing loudly.
    let assets: GhReleaseAssets = gh_json(
        data_dir,
        &[
            "release", "view", tag_name, "--repo", REPO, "--json", "assets",
        ],
    )
    .await
    .map_err(|err| cap_error(err.to_string()))?;
    // Gate finding (round 2, Medium): this header comment already claimed a release with more
    // than one `.exe` asset is rejected, but the code only ever `.find()`-picked the first match
    // silently -- fixed for real here: `.filter()` collects every `.exe` asset, and anything
    // other than exactly one is an error (zero: "missing an installer"; two or more: ambiguous,
    // never silently pick one).
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

    // Gate finding (round 3, Medium): a timed-out spawn's own `gh_raw` never writes anything to
    // stdout/stderr (see `github::gh::gh_raw`'s own timeout branch) -- without this check,
    // `non_empty_or` below would silently fall through to its generic `gh command failed: gh
    // {args_joined}` fallback, which is accurate but not as actionable as a plain, dedicated
    // message.
    if result.timed_out {
        return Err("Download timed out.".to_string());
    }
    if result.code != 0 {
        // Security fix (gate round 2, Medium): routed through the shared, redacting
        // `github::gh::non_empty_or` (never echoes a credential-shaped substring verbatim)
        // rather than the deleted `gh_client::capped_failure_text`'s own unredacted
        // stderr/stdout pick; capped via the shared `cap_error` helper (also used by the
        // `release view` error path above), matching the deleted function's own cap --
        // redaction alone is not sufficient, an unbounded `gh` response must never
        // persist/display in full.
        let detail = non_empty_or(
            &result.stderr,
            &result.stdout,
            &format!("gh command failed: gh {args_joined}"),
        );
        return Err(cap_error(detail));
    }

    // Gate finding (round 2, Medium): `installer_name`/`checksum_name` are release-asset names
    // sourced from `gh`'s own JSON (not a caller-supplied value, but still worth a defensive
    // strip) -- `safe_file_name` only at this LOCAL path-join point, matching
    // `dependency_install.rs`'s own `install_git`/`install_github_cli` convention; the `--pattern`
    // arguments above intentionally stay the raw API names so they still match the real remote
    // asset.
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
        // Both paths are always children of `updates_dir` (`<data_dir>/updates`), never derived
        // from caller input.
        let _ = tokio::fs::remove_file(&installer_path).await;
        let _ = tokio::fs::remove_file(&checksum_path).await;
        return Err("The downloaded installer did not match its published checksum.".to_string());
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
