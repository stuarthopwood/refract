// Shells out only to the signed-in `gh` CLI, never a stored token. The store lock is never held across `gh`.
// The final commit re-reads the phase so a download or install started mid-scan is not clobbered.

use std::path::Path;

use serde::Deserialize;

use super::gh_client::{self, GithubCliStatus};
use super::state::{SharedUpdateState, UnavailableReason, UpdatePhase, UpdateState};
use crate::github::gh::gh_json;

/// The private repository every release is published to.
pub const REPO: &str = "stuarthopwood/refract";

#[derive(Deserialize)]
struct GhReleaseListEntry {
    #[serde(rename = "tagName")]
    tag_name: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    #[serde(rename = "isPrerelease")]
    is_prerelease: bool,
}

#[derive(Deserialize)]
struct GhReleaseAsset {
    name: String,
}

#[derive(Deserialize)]
struct GhReleaseAssets {
    assets: Vec<GhReleaseAsset>,
}

/// Compares `X.Y.Z` numerically, so `1.10.0` outranks `1.9.0`.
pub fn compare_versions(a: &str, b: &str) -> i64 {
    let parts_a = parse_version_parts(a);
    let parts_b = parse_version_parts(b);
    for i in 0..3 {
        let diff = parts_a[i] - parts_b[i];
        if diff != 0 {
            return diff;
        }
    }
    0
}

fn parse_version_parts(version: &str) -> [i64; 3] {
    let mut parts = [0i64; 3];
    for (i, segment) in version.split('.').enumerate().take(3) {
        parts[i] = segment.parse::<i64>().unwrap_or(0);
    }
    parts
}

/// Matches `vX.Y.Z` only; `compare_versions` would rank odd tags such as `v1.2.0-rc1` above the release.
fn is_release_tag(tag: &str) -> bool {
    let Some(rest) = tag.strip_prefix('v') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('.').collect();
    segments.len() == 3
        && segments
            .iter()
            .all(|segment| !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit()))
}

/// Phases a check must never clobber, whichever caller runs it.
fn is_busy(phase: UpdatePhase) -> bool {
    matches!(
        phase,
        UpdatePhase::Downloading | UpdatePhase::Downloaded | UpdatePhase::Installing
    )
}

/// The outcome of a `gh` scan, decided without holding the store lock.
enum Outcome {
    Available { version: String, notes_url: String },
    Idle,
    Unavailable(UnavailableReason),
}

/// `updates.check()`: never panics or returns an IPC error. No-op while `downloading`,
/// `downloaded` or `installing`. Startup skips `failed` so `lastError` survives.
pub async fn check_for_updates(
    store: &SharedUpdateState,
    automatic: bool,
    current_version: &str,
    on_state: &(dyn Fn(&UpdateState) + Send + Sync),
) -> UpdateState {
    let checking_state = {
        let mut guard = store.lock().await;
        let state = guard.get();
        if is_busy(state.phase) {
            return state;
        }
        if automatic && matches!(state.phase, UpdatePhase::Failed) {
            return state;
        }
        guard.update(|s| s.phase = UpdatePhase::Checking).await
    };
    on_state(&checking_state);

    let cwd = std::env::temp_dir();
    let now = crate::ipc::now_iso8601();

    let access = gh_client::github_cli_status(&cwd).await;
    let outcome = match access {
        GithubCliStatus::NotInstalled => Outcome::Unavailable(UnavailableReason::NotInstalled),
        GithubCliStatus::NotSignedIn => Outcome::Unavailable(UnavailableReason::NotSignedIn),
        GithubCliStatus::Offline => Outcome::Unavailable(UnavailableReason::Offline),
        GithubCliStatus::Ok => match scan_releases(&cwd, current_version).await {
            Ok(Some((version, tag_name))) => Outcome::Available {
                version,
                notes_url: format!("https://github.com/{REPO}/releases/tag/{tag_name}"),
            },
            Ok(None) => Outcome::Idle,
            Err(()) => {
                // A list/view failure may be a rate limit, not offline. Only a vanished `gh` is `NotInstalled`.
                let reason = match crate::github::gh::resolve_gh() {
                    Ok(_) => UnavailableReason::Offline,
                    Err(_) => UnavailableReason::NotInstalled,
                };
                Outcome::Unavailable(reason)
            }
        },
    };

    let mut guard = store.lock().await;
    let current = guard.get();
    if is_busy(current.phase) {
        // Drop the result rather than clobber a download or install started during the scan.
        return current;
    }
    let committed = match outcome {
        Outcome::Available { version, notes_url } => {
            guard
                .update(|s| {
                    s.phase = UpdatePhase::Available;
                    s.available_version = Some(version);
                    s.notes_url = Some(notes_url);
                    s.last_checked_at = Some(now);
                    s.unavailable_reason = None;
                    s.last_error = None;
                })
                .await
        }
        Outcome::Idle => {
            guard
                .update(|s| {
                    s.phase = UpdatePhase::Idle;
                    s.last_checked_at = Some(now);
                    s.unavailable_reason = None;
                    s.available_version = None;
                    s.notes_url = None;
                    s.last_error = None;
                })
                .await
        }
        Outcome::Unavailable(reason) => {
            guard
                .update(|s| {
                    s.phase = UpdatePhase::Idle;
                    s.unavailable_reason = Some(reason);
                    s.last_checked_at = Some(now);
                    s.available_version = None;
                    s.notes_url = None;
                    s.last_error = None;
                })
                .await
        }
    };
    drop(guard);
    on_state(&committed);
    committed
}

/// Returns the highest newer release; `Err(())` means a `gh` call failed.
async fn scan_releases(cwd: &Path, current_version: &str) -> Result<Option<(String, String)>, ()> {
    let releases: Vec<GhReleaseListEntry> = gh_json(
        cwd,
        &[
            "release",
            "list",
            "--repo",
            REPO,
            "--json",
            "tagName,isDraft,isPrerelease",
            "--limit",
            "20",
        ],
    )
    .await
    .map_err(|_| ())?;

    let mut best: Option<(String, String)> = None;
    for release in &releases {
        // Pre-releases and drafts are never offered.
        if release.is_draft || release.is_prerelease {
            continue;
        }
        if !is_release_tag(&release.tag_name) {
            continue;
        }
        let version = release.tag_name[1..].to_string();
        if let Some((best_version, _)) = &best {
            if compare_versions(&version, best_version) <= 0 {
                continue;
            }
        }
        let detail: GhReleaseAssets = gh_json(
            cwd,
            &[
                "release",
                "view",
                &release.tag_name,
                "--repo",
                REPO,
                "--json",
                "assets",
            ],
        )
        .await
        .map_err(|_| ())?;
        let has_installer = detail
            .assets
            .iter()
            .any(|asset| asset.name.to_lowercase().ends_with(".exe"));
        let has_checksum = detail
            .assets
            .iter()
            .any(|asset| asset.name.to_lowercase().ends_with(".sha256"));
        // A release missing either asset is never offered.
        if !has_installer || !has_checksum {
            continue;
        }
        best = Some((version, release.tag_name.clone()));
    }

    match best {
        Some((version, tag_name)) if compare_versions(&version, current_version) > 0 => {
            Ok(Some((version, tag_name)))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_versions_newer_older_equal() {
        assert!(compare_versions("1.2.0", "1.1.9") > 0);
        assert!(compare_versions("2.0.0", "1.9.9") > 0);
        assert!(compare_versions("1.1.9", "1.2.0") < 0);
        assert!(compare_versions("1.2.3", "1.2.3") == 0);
    }

    #[test]
    fn compare_versions_treats_malformed_segment_as_zero() {
        // Never panics on a malformed segment, even though the tag guard filters those out.
        assert!(compare_versions("1.x.0", "1.0.0") == 0);
        assert!(compare_versions("1.2.0", "1.x.0") > 0);
    }

    #[test]
    fn compare_versions_compares_multi_digit_segments_numerically_not_lexicographically() {
        assert!(compare_versions("1.10.0", "1.9.0") > 0);
        assert!(compare_versions("1.9.0", "1.10.0") < 0);
    }

    #[test]
    fn release_tag_accepts_plain_v_major_minor_patch() {
        assert!(is_release_tag("v1.2.3"));
        assert!(is_release_tag("v0.2.0"));
    }

    #[test]
    fn release_tag_rejects_non_plain_shapes() {
        assert!(!is_release_tag("1.2.3"), "missing leading v");
        assert!(!is_release_tag("V1.2.3"), "uppercase V");
        assert!(!is_release_tag("v1.2.0-rc1"), "pre-release suffix");
        assert!(!is_release_tag("v1.2"), "wrong digit grouping (two parts)");
        assert!(
            !is_release_tag("v1.2.3.4"),
            "wrong digit grouping (four parts)"
        );
        assert!(!is_release_tag("v1.2."), "empty trailing segment");
    }
}
