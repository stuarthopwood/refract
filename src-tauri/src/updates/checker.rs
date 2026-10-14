// Update availability check (spec 006 FR-012 to FR-019, FR-026; specs/006-installer-and-updates/
// research.md decision 3; lane R11b, issue #794): a hand-rolled checker that only ever shells out
// to the developer's own already-signed-in `gh` CLI (`updates::gh_client`, resolved via PATH) --
// never a stored token (spec 003 FR-027's same stance). Port of `UpdateChecker.ts`'s
// `checkForUpdates`/`compareVersions`/its tag-shape guard/its busy-phases no-clobber guard/its
// best-candidate-over-the-whole-list scan; every fix below is ported from that file's own
// quality-gate-remediation comments, not re-derived.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use super::gh_client::{self, GithubCliStatus};
use super::state::{UnavailableReason, UpdatePhase, UpdateState, UpdateStateStore};

/// research.md decision 8: the private repository every release is published to.
pub const REPO: &str = "stuarthopwood/refract";

const GH_METADATA_TIMEOUT: Duration = Duration::from_secs(15);

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

/// research.md decision 9: a small hand-written three-part numeric compare, not a `semver`
/// crate -- FR-019/FR-026 already filter out every pre-release/draft/malformed tag before a
/// version ever reaches this comparison (via `is_release_tag`), so every version compared here is
/// a plain `X.Y.Z` string with no suffix to parse. Positive when `a` is newer than `b`, negative
/// when older, `0` when equal. An unparseable segment reads as `0`, matching the TS port's own
/// `Number.parseInt(part, 10) || 0` (never an error -- the tag-shape guard is what keeps a
/// genuinely malformed version out of this comparison in the first place).
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

/// Quality-gate remediation (LOW "tag names not validated" / HIGH "pre-release guard fails open
/// at both ends", ported from `UpdateChecker.ts`'s own `RELEASE_TAG_RE` comment): every release's
/// own tag is checked against this before it is ever compared or passed to a second `gh` call --
/// `isDraft`/`isPrerelease` alone do not catch every non-plain tag shape (a mistyped or
/// non-standard tag, e.g. `v1.2.0-rc1` with no dot before `rc`, or `1.2.0` with no leading `v`),
/// and `compare_versions`'s own "unparseable segment reads as 0" rule would otherwise let a
/// pre-release outrank a real release with the same numeric prefix. Lowercase `v` only, hand-
/// matching `^v\d+\.\d+\.\d+$` (no regex crate in this build): matches the tags
/// `.github/workflows/release.yml` actually produces.
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

/// contracts/ipc.md "Updates": phases a check must never clobber, whichever caller runs it
/// (data-model.md's own phase-transition table only allows `check()` from idle/available/failed).
fn is_busy(phase: UpdatePhase) -> bool {
    matches!(
        phase,
        UpdatePhase::Downloading | UpdatePhase::Downloaded | UpdatePhase::Installing
    )
}

/// `updates.check()` (contracts/ipc.md): never panics, never returns an IPC error -- the caller
/// always gets a fresh/updated `UpdateState` back.
///
/// Quality-gate remediation (HIGH "checkForUpdates overwrites whatever phase is current", ported):
/// `automatic` distinguishes the startup call from the user-initiated `updates.check` IPC
/// request:
/// - Both are a no-op (return the current state unchanged) while `downloading`, `downloaded`, or
///   `installing` -- a check must never clobber a download in flight or a verified installer
///   already waiting for the next quit.
/// - Only the automatic one is ALSO a no-op on `failed` -- the previous check's own `lastError`
///   (FR-018) must survive the startup check that runs right after it; the user-initiated call
///   (the status bar's own "Try again") still re-checks from `failed`.
///
/// `current_version` is this build's own running version, passed in by the caller rather than
/// read from `tauri::Config` here, for testability. `cwd` for every `gh` call is
/// `std::env::temp_dir()`: this module has no repository context of its own.
pub async fn check_for_updates(
    store: &mut UpdateStateStore,
    automatic: bool,
    current_version: &str,
) -> UpdateState {
    let state = store.get();
    if is_busy(state.phase) {
        return state;
    }
    if automatic && matches!(state.phase, UpdatePhase::Failed) {
        return state;
    }

    let cwd = std::env::temp_dir();
    let now = crate::ipc::now_iso8601();

    let access = gh_client::github_cli_status(&cwd).await;
    let unavailable = match access {
        GithubCliStatus::Ok => None,
        GithubCliStatus::NotInstalled => Some(UnavailableReason::NotInstalled),
        GithubCliStatus::NotSignedIn => Some(UnavailableReason::NotSignedIn),
        GithubCliStatus::Offline => Some(UnavailableReason::Offline),
    };
    if let Some(reason) = unavailable {
        return store
            .update(|s| {
                s.phase = UpdatePhase::Idle;
                s.unavailable_reason = Some(reason);
                s.last_checked_at = Some(now);
            })
            .await;
    }

    match scan_releases(&cwd, current_version).await {
        Ok(Some((version, tag_name))) => {
            let notes_url = format!("https://github.com/{REPO}/releases/tag/{tag_name}");
            store
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
        Ok(None) => {
            store
                .update(|s| {
                    s.phase = UpdatePhase::Idle;
                    s.last_checked_at = Some(now);
                    s.unavailable_reason = None;
                })
                .await
        }
        Err(()) => {
            // Quality-gate remediation (LOW "every release list/view failure is reported as
            // offline", ported): `github_cli_status` above already confirmed `gh` is installed
            // and reachable, so a failure here (rate limiting, a 404/no-access response, invalid
            // JSON) is a `gh`-reported failure, not necessarily the network -- `NotInstalled` is
            // reserved for the rare case `gh` itself became unresolvable on PATH between the two
            // calls (checked directly via `resolve_gh`, since this module's simplified
            // `gh_client::gh_json` does not carry a typed error code the way `gh.ts`'s `GhError`
            // does); every other `gh` failure maps to `Offline`, the closest remaining fit in
            // `UnavailableReason`'s fixed three-value enum.
            let reason = match gh_client::resolve_gh() {
                Ok(_) => UnavailableReason::Offline,
                Err(_) => UnavailableReason::NotInstalled,
            };
            store
                .update(|s| {
                    s.phase = UpdatePhase::Idle;
                    s.unavailable_reason = Some(reason);
                    s.last_checked_at = Some(now);
                })
                .await
        }
    }
}

/// Scans `gh release list` (ordered by creation date, not version) for the highest qualifying
/// release over the WHOLE list rather than stopping at the first entry newer than
/// `current_version` -- quality-gate remediation (LOW, ported): a later-created backport release
/// could otherwise stop the scan before a higher, earlier-created version is ever considered.
/// Only fetches a candidate's assets (a second `gh` call) once it could actually improve on the
/// best complete candidate found so far -- same `gh` call volume as a naive first-match scan in
/// the common case, strictly more only in the rare backport case the fix above targets.
///
/// `Ok(None)` means nothing newer than `current_version` qualifies (not an error). `Err(())` means
/// a `gh` call itself failed (the list call, or an improving candidate's asset check) and the
/// whole check must abort -- matching `checkForUpdates`'s own single try/catch wrapped around this
/// entire scan: any failure here, including one on a later candidate, discards the whole scan
/// rather than silently skipping just that candidate.
async fn scan_releases(cwd: &Path, current_version: &str) -> Result<Option<(String, String)>, ()> {
    let releases: Vec<GhReleaseListEntry> = gh_client::gh_json(
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
        GH_METADATA_TIMEOUT,
    )
    .await
    .map_err(|_| ())?;

    let mut best: Option<(String, String)> = None;
    for release in &releases {
        // FR-019, FR-026: a pre-release or draft release is never offered as an update.
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
        let detail: GhReleaseAssets = gh_client::gh_json(
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
            GH_METADATA_TIMEOUT,
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
        // FR-026: a release missing either asset is ignored entirely, never offered.
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
        // Not a real-world input (the tag-shape guard filters this out before comparison), but
        // `compare_versions` itself must never panic or error on one -- ported directly from
        // `compareVersions.ts`'s own `Number.parseInt(...) || 0` fallback.
        assert!(compare_versions("1.x.0", "1.0.0") == 0);
        assert!(compare_versions("1.2.0", "1.x.0") > 0);
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
