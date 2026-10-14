// Wire shapes for `accounts.*` (`src/shared/ipc.ts`'s `GitHubAccount`/`GitHubAddFlowProgress`,
// specs/008-profile-and-accounts data-model.md) and the pure, side-effect-free logic the handlers
// in `handlers.rs` and the orchestration in `mod.rs` share: flattening a `gh auth status` host
// list with `profileCache.json`'s cached display fields, the two `gh auth switch`/`gh auth
// logout` after-images (`project_switch`/`project_sign_out`), the opportunistic-refresh
// staleness test (`is_profile_refresh_due`), and the fixed-sentence GitHub-CLI error mapping
// (GateUi008 M7: the renderer only ever sees one of a few plain-language sentences, never a raw
// `gh` stderr line or a `--user <login>` argument). Split out of `mod.rs` to stay under the
// 600-line-per-file cap (issue #806), matching `ipc/pull_requests`'s own `mod.rs`/`mapping.rs`/
// `handlers.rs` split.

use serde::Serialize;

use crate::github::cli::{GhAccountProblem, GhAuthHostEntry};
use crate::github::gh::GhError;
use crate::ipc::IpcError;
use crate::store::profile_cache::{ProfileCacheEntry, ProfileCacheStore};

/// spec 008 data-model.md: one GitHub CLI account across every signed-in host; never includes a
/// token (FR-012, constitution V). `display_name`/`avatar_data_url` come from
/// `profileCache.json`, refreshed opportunistically (research.md decision 5) -- both absent
/// until first fetched, in which case the renderer shows `login` and initials respectively.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount {
    pub host: String,
    pub login: String,
    pub active: bool,
    pub state: String,
    /// Why `state` is not `"success"`, classified from `gh`'s own per-account error text (never
    /// shown raw). Absent when `state` is `"success"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<&'static str>,
    pub display_name: Option<String>,
    pub avatar_data_url: Option<String>,
}

/// spec 008 contracts/ipc.md `accounts:github-add-progress`: the add-account flow's one-time
/// code and progress (FR-009), pushed until the flow completes, is cancelled, or fails.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAddFlowProgress {
    pub flow_id: String,
    pub code: String,
    pub status: AddFlowStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AddFlowStatus {
    Waiting,
    Completed,
    Cancelled,
    Failed,
}

/// Flattens the CLI's account list with `profileCache.json`'s cached display fields (the pure,
/// no-refresh read every caller in `mod.rs` shares: the explicit `list()` path, the
/// background-refresh re-read, a switch/sign-out's post-mutation reconcile, and the
/// completed-add path).
pub(super) fn to_github_accounts(
    hosts: &[GhAuthHostEntry],
    cache: &ProfileCacheStore,
) -> Vec<GitHubAccount> {
    hosts
        .iter()
        .map(|entry| {
            let cached = cache.get(&entry.host, &entry.login);
            GitHubAccount {
                host: entry.host.clone(),
                login: entry.login.clone(),
                active: entry.active,
                state: entry.state.clone(),
                problem: entry.problem.map(GhAccountProblem::as_str),
                display_name: cached.and_then(|e| e.display_name.clone()),
                avatar_data_url: cached.and_then(|e| e.avatar_data_url.clone()),
            }
        })
        .collect()
}

/// What `gh auth switch --hostname <host> --user <login>` leaves behind: on that host the chosen
/// account is active, every other account (and every other host) unchanged.
pub(super) fn project_switch(
    hosts: &[GhAuthHostEntry],
    host: &str,
    login: &str,
) -> Vec<GhAuthHostEntry> {
    hosts
        .iter()
        .map(|entry| {
            if entry.host == host {
                GhAuthHostEntry {
                    active: entry.login == login,
                    ..entry.clone()
                }
            } else {
                entry.clone()
            }
        })
        .collect()
}

/// What `gh auth logout --hostname <host> --user <login>` leaves behind: the account is gone
/// and, when it was the active one, the CLI activates the first remaining account on that host
/// in its own listing order (verified live against a two- and three-account config, including a
/// non-alphabetical order).
pub(super) fn project_sign_out(
    hosts: &[GhAuthHostEntry],
    host: &str,
    login: &str,
) -> Vec<GhAuthHostEntry> {
    let removed_was_active = hosts
        .iter()
        .any(|entry| entry.host == host && entry.login == login && entry.active);
    let remaining: Vec<GhAuthHostEntry> = hosts
        .iter()
        .filter(|entry| !(entry.host == host && entry.login == login))
        .cloned()
        .collect();
    if !removed_was_active {
        return remaining;
    }
    match remaining.iter().position(|entry| entry.host == host) {
        Some(index) => {
            let mut remaining = remaining;
            remaining[index].active = true;
            remaining
        }
        None => remaining,
    }
}

/// research.md decision 5 / GateCode008 MEDIUM "profile refetched on every list() call": an entry
/// fetched within the last hour is left alone; a login with no entry yet, or whose last attempt
/// came back with neither a `displayName` nor an `avatarDataUrl` (a failure) more than five
/// minutes ago, is still due. An unparseable or future `fetchedAt` (hand-edited file, clock moved
/// back) is due, never "fresh".
pub(super) fn is_profile_refresh_due(entry: Option<&ProfileCacheEntry>, now_millis: i64) -> bool {
    let Some(entry) = entry else { return true };
    let Some(fetched_millis) = parse_iso8601_millis(&entry.fetched_at) else {
        return true;
    };
    let age_ms = now_millis - fetched_millis;
    if age_ms < 0 {
        return true;
    }
    let came_back_empty = entry.display_name.is_none() && entry.avatar_data_url.is_none();
    if came_back_empty {
        age_ms > 5 * 60 * 1000
    } else {
        age_ms > 60 * 60 * 1000
    }
}

pub(super) fn now_epoch_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Parses exactly the shape `crate::ipc::now_iso8601()` produces
/// (`"YYYY-MM-DDTHH:MM:SS.mmmZ"`, UTC only) -- the only format ever written to
/// `ProfileCacheEntry.fetched_at`. Returns `None` for anything else (a hand-edited file, a
/// different precision), which `is_profile_refresh_due` above treats as "due", matching
/// `Date.parse`'s own NaN-on-unparseable fallback the ported TS relied on. No `chrono`/`time`
/// crate dependency (neither is in this build's `Cargo.toml`): the inverse of `ipc::mod`'s own
/// `civil_from_days` (Howard Hinnant's well-known `days_from_civil` algorithm), UTC only.
fn parse_iso8601_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    let millis: i64 = value.get(20..23)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour >= 24
        || minute >= 60
        || second >= 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(secs * 1000 + millis)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) as u64 + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

pub(super) const DEFAULT_GITHUB_ERROR_MESSAGE: &str =
    "GitHub CLI could not finish that. Try again.";

/// GateUi008 M7: the renderer only ever sees one of these fixed, plain-language sentences for a
/// GitHub-CLI-related failure -- never the CLI's own stderr, a `gh ...` command line, or a
/// channel name. Codes outside this map fall back to `DEFAULT_GITHUB_ERROR_MESSAGE`.
pub(super) fn github_error_message(code: &str) -> &'static str {
    match code {
        "gh-not-found" => "GitHub CLI is not installed.",
        "account-not-found" => "That account is no longer signed in.",
        "timeout" => "GitHub CLI took too long to respond.",
        _ => DEFAULT_GITHUB_ERROR_MESSAGE,
    }
}

/// `err`'s raw message (which can carry a `--user <login>` argument) stays in this debug log
/// only -- the renderer only ever sees `github_error_message`'s fixed sentence.
pub(super) fn map_gh_error(err: GhError) -> IpcError {
    log::debug!(
        "accounts: GitHub CLI operation failed ({}): {}",
        err.code.as_str(),
        err.message
    );
    IpcError::new(err.code.as_str(), github_error_message(err.code.as_str()))
}

/// Mirrors the ported TS's own `toGithubError` catch-all branch: a non-`GhError` failure (a
/// `profileCache.json` read/write error, say) never leaves its own detail on the wire either,
/// collapsing to the same fixed `'gh-failed'` sentence -- and, matching that branch exactly, is
/// never itself logged (unlike `map_gh_error` above).
pub(super) fn map_io_error(_err: std::io::Error) -> IpcError {
    IpcError::new("gh-failed", DEFAULT_GITHUB_ERROR_MESSAGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(
        fetched_at: &str,
        display_name: Option<&str>,
        avatar: Option<&str>,
    ) -> ProfileCacheEntry {
        ProfileCacheEntry {
            display_name: display_name.map(str::to_string),
            avatar_data_url: avatar.map(str::to_string),
            fetched_at: fetched_at.to_string(),
        }
    }

    fn host_entry(
        host: &str,
        login: &str,
        active: bool,
        state: &str,
        problem: Option<GhAccountProblem>,
    ) -> GhAuthHostEntry {
        GhAuthHostEntry {
            host: host.to_string(),
            login: login.to_string(),
            active,
            state: state.to_string(),
            problem,
        }
    }

    #[test]
    fn parse_iso8601_millis_known_epoch() {
        assert_eq!(parse_iso8601_millis("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso8601_millis("1970-01-01T00:00:00.001Z"), Some(1));
        assert_eq!(
            parse_iso8601_millis("1970-01-01T00:01:00.000Z"),
            Some(60_000)
        );
    }

    #[test]
    fn parse_iso8601_millis_known_fixed_dates() {
        // Cross-checked against well-known Unix epoch values (independent of this module's own
        // `days_from_civil`), so this also catches a bug shared between the two.
        assert_eq!(
            parse_iso8601_millis("2024-01-01T00:00:00.000Z"),
            Some(1_704_067_200_000)
        );
        assert_eq!(
            parse_iso8601_millis("2024-03-01T00:00:00.000Z"),
            Some(1_709_251_200_000)
        ); // crosses 2024's Feb 29 leap day
        assert_eq!(
            parse_iso8601_millis("2000-01-01T00:00:00.000Z"),
            Some(946_684_800_000)
        );
    }

    #[test]
    fn parse_iso8601_millis_rejects_malformed() {
        assert_eq!(parse_iso8601_millis(""), None);
        assert_eq!(parse_iso8601_millis("not-a-date"), None);
        assert_eq!(parse_iso8601_millis("1970-01-01T00:00:00Z"), None); // no millis
        assert_eq!(parse_iso8601_millis("1970-13-01T00:00:00.000Z"), None); // bad month
    }

    #[test]
    fn profile_refresh_due_no_entry() {
        assert!(is_profile_refresh_due(None, 0));
    }

    #[test]
    fn profile_refresh_due_fresh_success_entry_not_due() {
        let now = parse_iso8601_millis("2026-01-01T00:00:00.000Z").unwrap();
        let fetched_at = "2026-01-01T00:00:00.000Z"; // same instant: zero age
        let entry = entry(fetched_at, Some("Ada"), Some("data:image/png;base64,x"));
        assert!(!is_profile_refresh_due(Some(&entry), now));
    }

    #[test]
    fn profile_refresh_due_success_entry_past_one_hour() {
        let fetched_at = "2026-01-01T00:00:00.000Z";
        let fetched_millis = parse_iso8601_millis(fetched_at).unwrap();
        let entry = entry(fetched_at, Some("Ada"), Some("data:image/png;base64,x"));
        assert!(!is_profile_refresh_due(
            Some(&entry),
            fetched_millis + 59 * 60 * 1000
        ));
        assert!(is_profile_refresh_due(
            Some(&entry),
            fetched_millis + 61 * 60 * 1000
        ));
    }

    #[test]
    fn profile_refresh_due_empty_entry_past_five_minutes() {
        let fetched_at = "2026-01-01T00:00:00.000Z";
        let fetched_millis = parse_iso8601_millis(fetched_at).unwrap();
        let entry = entry(fetched_at, None, None);
        assert!(!is_profile_refresh_due(
            Some(&entry),
            fetched_millis + 4 * 60 * 1000
        ));
        assert!(is_profile_refresh_due(
            Some(&entry),
            fetched_millis + 6 * 60 * 1000
        ));
    }

    #[test]
    fn profile_refresh_due_future_fetched_at_is_due() {
        let entry = entry("2026-01-01T00:00:00.000Z", Some("Ada"), None);
        let before = parse_iso8601_millis("2025-01-01T00:00:00.000Z").unwrap();
        assert!(is_profile_refresh_due(Some(&entry), before));
    }

    #[test]
    fn github_error_message_maps_known_codes_and_falls_back() {
        assert_eq!(
            github_error_message("gh-not-found"),
            "GitHub CLI is not installed."
        );
        assert_eq!(
            github_error_message("account-not-found"),
            "That account is no longer signed in."
        );
        assert_eq!(
            github_error_message("timeout"),
            "GitHub CLI took too long to respond."
        );
        assert_eq!(
            github_error_message("gh-failed"),
            DEFAULT_GITHUB_ERROR_MESSAGE
        );
        assert_eq!(
            github_error_message("rate-limited"),
            DEFAULT_GITHUB_ERROR_MESSAGE
        );
    }

    #[test]
    fn map_gh_error_never_leaks_the_raw_message_as_the_wire_message() {
        let err = GhError::new(
            crate::github::gh::GhErrorCode::GhFailed,
            "gh auth switch --hostname github.com --user some-secret-login failed",
        );
        let mapped = map_gh_error(err);
        assert_eq!(mapped.code, "gh-failed");
        assert_eq!(mapped.message, DEFAULT_GITHUB_ERROR_MESSAGE);
        assert!(!mapped.message.contains("some-secret-login"));
    }

    #[test]
    fn map_io_error_is_always_the_fixed_gh_failed_sentence() {
        let mapped = map_io_error(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "disk full, path leaked here",
        ));
        assert_eq!(mapped.code, "gh-failed");
        assert_eq!(mapped.message, DEFAULT_GITHUB_ERROR_MESSAGE);
    }

    #[test]
    fn project_switch_activates_only_the_chosen_login_on_that_host() {
        let hosts = vec![
            host_entry("github.com", "alice", true, "success", None),
            host_entry("github.com", "bob", false, "success", None),
            host_entry("ghe.example.com", "alice", true, "success", None),
        ];
        let projected = project_switch(&hosts, "github.com", "bob");
        assert!(!projected[0].active);
        assert!(projected[1].active);
        assert!(projected[2].active); // untouched: different host
    }

    #[test]
    fn project_sign_out_removes_and_promotes_successor_in_listing_order() {
        let hosts = vec![
            host_entry("github.com", "alice", true, "success", None),
            host_entry("github.com", "bob", false, "success", None),
            host_entry("github.com", "carol", false, "success", None),
        ];
        let projected = project_sign_out(&hosts, "github.com", "alice");
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0].login, "bob");
        assert!(projected[0].active); // first remaining account on that host, in listing order
        assert!(!projected[1].active);
    }

    #[test]
    fn project_sign_out_of_inactive_account_promotes_nobody() {
        let hosts = vec![
            host_entry("github.com", "alice", true, "success", None),
            host_entry("github.com", "bob", false, "success", None),
        ];
        let projected = project_sign_out(&hosts, "github.com", "bob");
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].login, "alice");
        assert!(projected[0].active);
    }

    #[tokio::test]
    async fn to_github_accounts_flattens_cache_hit_and_miss() {
        // A path that cannot exist yet: `ProfileCacheStore::open` treats a missing file as an
        // empty cache (`atomic_json::read_json_file`'s own documented ENOENT-is-default
        // behaviour), so this never touches disk -- no tempdir needed for the "miss" half.
        let scratch = std::env::temp_dir().join(format!(
            "refract-accounts-test-{}-{}",
            std::process::id(),
            now_epoch_millis()
        ));
        let mut cache = ProfileCacheStore::open(&scratch)
            .await
            .expect("open never fails on a missing file");
        cache
            .set(
                "github.com",
                "alice",
                ProfileCacheEntry {
                    display_name: Some("Ada".to_string()),
                    avatar_data_url: Some("data:image/png;base64,x".to_string()),
                    fetched_at: "2026-01-01T00:00:00.000Z".to_string(),
                },
            )
            .await
            .expect("set writes under the scratch dir it just created");

        let hosts = vec![
            host_entry("github.com", "alice", true, "success", None),
            host_entry("github.com", "bob", false, "success", None),
        ];
        let accounts = to_github_accounts(&hosts, &cache);
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].display_name.as_deref(), Some("Ada")); // cache hit
        assert_eq!(accounts[1].display_name, None); // cache miss: never fetched
        assert_eq!(accounts[1].avatar_data_url, None);

        let _ = std::fs::remove_dir_all(&scratch);
    }
}
