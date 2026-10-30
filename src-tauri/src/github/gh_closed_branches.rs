// The `gh` surface behind the Home view's Tidy-up list (issue #869, spec 059): your recently
// merged or closed pull requests in one repository, so the renderer can match them to Session
// branches. Same safety model as `gh_issue_list.rs`: owner/repo comes from the repository's own
// remote via `owner_repo_for`, the call is an argv array, and every returned field is untrusted
// text; a pull request URL is kept only when it points at the scoped repository.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::gh::{gh_json, GhError};

const LIST_LIMIT: &str = "100";
const LIST_FIELDS: &str = "number,state,url,headRefName,headRepositoryOwner";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    number: u64,
    #[serde(default)]
    state: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    head_repository_owner: Option<RawOwner>,
}

#[derive(Debug, Deserialize)]
struct RawOwner {
    #[serde(default)]
    login: String,
}

/// One merged or closed pull request. `repository_id` is filled in by the IPC handler.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedBranchRow {
    pub branch: String,
    pub number: u64,
    pub url: String,
    pub state: &'static str,
}

fn pr_url_matches(url: &str, owner: &str, repo: &str, number: u64) -> bool {
    url.eq_ignore_ascii_case(&format!("https://github.com/{owner}/{repo}/pull/{number}"))
}

pub async fn list_closed_branches(
    repo_path: &Path,
    owner: &str,
    repo: &str,
) -> Result<Vec<ClosedBranchRow>, GhError> {
    let slug = format!("{owner}/{repo}");
    let raw: Vec<RawPr> = gh_json(
        repo_path,
        &[
            "pr",
            "list",
            "--repo",
            &slug,
            "--state",
            "all",
            "--author=@me",
            "--limit",
            LIST_LIMIT,
            "--json",
            LIST_FIELDS,
        ],
    )
    .await?;
    Ok(raw
        .into_iter()
        .filter(|pr| pr_url_matches(&pr.url, owner, repo, pr.number))
        .filter(|pr| {
            // A fork's head branch can share a name with a Session branch here; keep only
            // pull requests whose head lives in the scoped repository's owner.
            pr.head_repository_owner
                .as_ref()
                .is_some_and(|head| head.login.eq_ignore_ascii_case(owner))
        })
        .filter_map(|pr| {
            let state = match pr.state.as_str() {
                "MERGED" => "MERGED",
                "CLOSED" => "CLOSED",
                _ => return None,
            };
            (!pr.head_ref_name.is_empty()).then_some(ClosedBranchRow {
                branch: pr.head_ref_name,
                number: pr.number,
                url: pr.url,
                state,
            })
        })
        .collect())
}
