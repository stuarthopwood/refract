// Whether an issue or pull request author may write to the repository, gating the auto-sent kickoff.

use std::path::Path;
use std::time::Duration;

use super::gh::{gh_raw, TIMEOUT_MS};

/// GitHub logins are 1 to 39 characters of letters, digits and hyphens; anything else (a bot
/// suffix, a path separator) never reaches the `gh api` path.
fn is_usable_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `write`, `maintain` and `admin` pass; every other value, error or timeout fails closed.
pub fn permission_grants_write(permission: &str) -> bool {
    matches!(permission.trim(), "write" | "maintain" | "admin")
}

/// Whether login has write access to owner/repo; fails closed on any error.
pub async fn author_has_write_access(
    repo_path: &Path,
    owner: &str,
    repo: &str,
    login: &str,
) -> bool {
    if !is_usable_login(login) {
        return false;
    }
    let endpoint = format!("repos/{owner}/{repo}/collaborators/{login}/permission");
    let result = gh_raw(
        repo_path,
        &["api", &endpoint, "--jq", ".permission"],
        None,
        Duration::from_millis(TIMEOUT_MS),
    )
    .await;
    match result {
        Ok(output) if output.code == 0 && !output.timed_out => {
            permission_grants_write(&output.stdout)
        }
        _ => false,
    }
}
