// Spec 054 (issue #867, FR-026, FR-028): the "Clone from GitHub" dialog's repository listing,
// through the user's own `gh` CLI (no stored token). Read-only; never fails the whole listing for
// one owner (the caller reports a per-owner error).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::gh::{map_gh_failure, resolve_gh, GhError, GhErrorCode, GhRawResult};
use super::repo_ref::{is_valid_name, is_valid_owner};

/// Windows-only: `CREATE_NO_WINDOW`.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DESCRIPTION_CHARS: usize = 300;

/// One `gh repo list` row, already validated and sanitised, in the renderer's wire shape (less
/// `existingProjectId`, which the IPC layer adds).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoListItem {
    pub name_with_owner: String,
    pub description: Option<String>,
    pub is_private: bool,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepo {
    name_with_owner: Option<String>,
    description: Option<String>,
    is_private: Option<bool>,
    updated_at: Option<String>,
}

/// `gh <args>` pinned to github.com (`GH_HOST` set, enterprise token dropped), no shell.
async fn gh_pinned(args: &[&str]) -> Result<GhRawResult, GhError> {
    let gh_path = resolve_gh().map_err(|_| {
        GhError::new(
            GhErrorCode::GhUnavailable,
            "The GitHub CLI (gh) is not installed or not on PATH.",
        )
    })?;
    let mut command = tokio::process::Command::new(&gh_path);
    command
        .args(args)
        .current_dir(std::env::temp_dir())
        .env("GH_HOST", "github.com")
        .env_remove("GH_ENTERPRISE_TOKEN")
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    Ok(
        match tokio::time::timeout(LIST_TIMEOUT, command.output()).await {
            Ok(Ok(output)) => GhRawResult {
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                code: output.status.code().unwrap_or(1),
                timed_out: false,
            },
            Ok(Err(_)) => GhRawResult {
                stdout: String::new(),
                stderr: String::new(),
                code: 1,
                timed_out: false,
            },
            Err(_) => GhRawResult {
                stdout: String::new(),
                stderr: String::new(),
                code: 1,
                timed_out: true,
            },
        },
    )
}

fn is_hidden_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

/// FR-028: control and bidi/format characters removed (line breaks and tabs become a space),
/// whitespace collapsed, truncated to 300 characters. `None` when nothing is left.
pub fn sanitise_description(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter_map(|c| {
            if c.is_whitespace() {
                Some(' ')
            } else if c.is_control() || is_hidden_format_char(c) {
                None
            } else {
                Some(c)
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(MAX_DESCRIPTION_CHARS).collect())
}

fn failure(code: GhErrorCode, fallback: &str) -> GhError {
    GhError::new(code, fallback)
}

/// Signed-in `github.com` account logins (healthy accounts only), the active one first.
pub async fn signed_in_logins() -> Result<Vec<String>, GhError> {
    let mut entries = super::cli::auth_status().await?;
    entries.retain(|e| {
        e.host.eq_ignore_ascii_case("github.com") && e.state == "success" && e.problem.is_none()
    });
    entries.sort_by_key(|e| !e.active);
    let mut logins: Vec<String> = Vec::new();
    for entry in entries {
        if is_valid_owner(&entry.login)
            && !logins.iter().any(|l| l.eq_ignore_ascii_case(&entry.login))
        {
            logins.push(entry.login);
        }
    }
    Ok(logins)
}

/// Organisations of the ACTIVE account (`gh api user/orgs`), A to Z, each re-validated.
pub async fn list_orgs() -> Result<Vec<String>, GhError> {
    let args = ["api", "user/orgs", "--paginate", "--jq", ".[].login"];
    let result = gh_pinned(&args).await?;
    if result.timed_out {
        return Err(failure(GhErrorCode::Timeout, "GitHub did not respond."));
    }
    if result.code != 0 {
        let mapped = map_gh_failure(&result.stderr, &result.stdout);
        return Err(failure(mapped.code, "Couldn't list organisations."));
    }
    let mut orgs: Vec<String> = result
        .stdout
        .lines()
        .map(str::trim)
        .filter(|login| is_valid_owner(login))
        .map(str::to_string)
        .collect();
    orgs.sort_by_key(|login| login.to_ascii_lowercase());
    orgs.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    Ok(orgs)
}

/// The 100 most recently updated repositories of `owner` (a validated owner, checked again here).
pub async fn list_owner_repos(owner: &str) -> Result<Vec<RepoListItem>, GhError> {
    if !is_valid_owner(owner) {
        return Err(failure(GhErrorCode::GhFailed, "Invalid owner."));
    }
    let args = [
        "repo",
        "list",
        owner,
        "--json",
        "nameWithOwner,description,isPrivate,updatedAt",
        "--limit",
        "100",
    ];
    let result = gh_pinned(&args).await?;
    if result.timed_out {
        return Err(failure(GhErrorCode::Timeout, "GitHub did not respond."));
    }
    if result.code != 0 {
        let mapped = map_gh_failure(&result.stderr, &result.stdout);
        return Err(failure(mapped.code, "Couldn't list repositories."));
    }
    let raw: Vec<RawRepo> = serde_json::from_str(&result.stdout).map_err(|_| {
        failure(
            GhErrorCode::GithubFailed,
            "GitHub returned an unexpected reply.",
        )
    })?;
    let mut items: Vec<RepoListItem> = raw
        .into_iter()
        .filter_map(|repo| {
            let name_with_owner = repo.name_with_owner?;
            let (repo_owner, name) = name_with_owner.split_once('/')?;
            if !is_valid_owner(repo_owner) || !is_valid_name(name) {
                return None;
            }
            Some(RepoListItem {
                description: repo.description.as_deref().and_then(sanitise_description),
                is_private: repo.is_private.unwrap_or(false),
                updated_at: repo.updated_at.unwrap_or_default(),
                name_with_owner,
            })
        })
        .collect();
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}
