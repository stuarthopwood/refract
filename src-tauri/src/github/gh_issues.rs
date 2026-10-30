// Report-an-issue surface. Calls use an argv array scoped to the repo's own remote; user
// text is one `--flag=value` entry or stdin, so it can never be read as a flag.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::gh::{gh_json, map_gh_failure, owner_repo_for, resolve_gh, GhError, GhErrorCode};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_TIMEOUT: Duration = Duration::from_secs(30);

pub const MAX_TITLE_CHARS: usize = 256;
pub const MAX_BODY_CHARS: usize = 60_000;
pub const MAX_LABELS: usize = 20;
pub const MAX_LABEL_CHARS: usize = 50;
pub const MAX_QUERY_CHARS: usize = 256;
const DUPLICATE_LIMIT: &str = "5";
const LABEL_LIMIT: &str = "200";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhIssueLabel {
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhIssueMatch {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCreatedIssue {
    pub number: u64,
    pub url: String,
}

fn invalid(message: &str) -> GhError {
    GhError::new(GhErrorCode::GhFailed, message)
}

fn has_control_char(value: &str) -> bool {
    value.chars().any(char::is_control)
}

/// A title is one line of text: no control characters (so no newline), 1 to 256 characters.
pub fn validate_title(raw: &str) -> Result<String, GhError> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(invalid("Enter a title for the issue."));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(invalid("The title is longer than 256 characters."));
    }
    if has_control_char(title) {
        return Err(invalid(
            "The title cannot contain line breaks or control characters.",
        ));
    }
    Ok(title.to_string())
}

pub fn validate_body(raw: &str) -> Result<&str, GhError> {
    if raw.chars().count() > MAX_BODY_CHARS {
        return Err(invalid("The description is longer than 60,000 characters."));
    }
    Ok(raw)
}

/// `gh issue create --label` splits on commas, so a comma would silently become two labels.
pub fn validate_labels(raw: &[String]) -> Result<Vec<String>, GhError> {
    if raw.len() > MAX_LABELS {
        return Err(invalid("Choose at most 20 labels."));
    }
    let mut labels: Vec<String> = Vec::with_capacity(raw.len());
    for label in raw {
        let label = label.trim();
        if label.is_empty()
            || label.chars().count() > MAX_LABEL_CHARS
            || has_control_char(label)
            || label.contains(',')
        {
            return Err(invalid("A chosen label is not a valid GitHub label name."));
        }
        if !labels.iter().any(|existing| existing == label) {
            labels.push(label.to_string());
        }
    }
    Ok(labels)
}

/// The duplicate-search text: control characters become spaces, then it is trimmed and capped.
/// `None` means nothing searchable is left.
pub fn clean_search_query(raw: &str) -> Option<String> {
    let spaced: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = trimmed.chars().take(MAX_QUERY_CHARS).collect();
    if capped.is_empty() {
        None
    } else {
        Some(capped)
    }
}

/// `https://github.com/<owner>/<repo>/issues/<n>` is the only shape `gh issue create` prints on
/// success; the URL is checked against the repository the call was scoped to.
pub fn parse_created_issue(stdout: &str, owner: &str, repo: &str) -> Option<GhCreatedIssue> {
    let url = stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| line.starts_with("https://"))?;
    let rest = url.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let (url_owner, url_repo, kind, number) =
        (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some()
        || kind != "issues"
        || !url_owner.eq_ignore_ascii_case(owner)
        || !url_repo.eq_ignore_ascii_case(repo)
    {
        return None;
    }
    let number: u64 = number.parse().ok()?;
    Some(GhCreatedIssue {
        number,
        url: url.to_string(),
    })
}

pub async fn list_labels(repo_path: &Path) -> Result<Vec<GhIssueLabel>, GhError> {
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let slug = format!("{owner}/{repo}");
    gh_json(
        repo_path,
        &[
            "label",
            "list",
            "--repo",
            &slug,
            "--limit",
            LABEL_LIMIT,
            "--json",
            "name,color,description",
        ],
    )
    .await
}

pub async fn search_issues(repo_path: &Path, query: &str) -> Result<Vec<GhIssueMatch>, GhError> {
    let Some(query) = clean_search_query(query) else {
        return Ok(Vec::new());
    };
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let slug = format!("{owner}/{repo}");
    let search = format!("--search={query}");
    gh_json(
        repo_path,
        &[
            "issue",
            "list",
            "--repo",
            &slug,
            "--state",
            "all",
            &search,
            "--limit",
            DUPLICATE_LIMIT,
            "--json",
            "number,title,state,url",
        ],
    )
    .await
}

pub async fn create_issue(
    repo_path: &Path,
    title: &str,
    body: &str,
    labels: &[String],
) -> Result<GhCreatedIssue, GhError> {
    let title = validate_title(title)?;
    let body = validate_body(body)?;
    let labels = validate_labels(labels)?;
    let (owner, repo) = owner_repo_for(repo_path).await?;
    let slug = format!("{owner}/{repo}");

    let mut args: Vec<String> = vec![
        "issue".into(),
        "create".into(),
        "--repo".into(),
        slug,
        format!("--title={title}"),
        "--body-file".into(),
        "-".into(),
    ];
    args.extend(labels.iter().map(|label| format!("--label={label}")));

    let gh_path = resolve_gh().map_err(|_| {
        GhError::new(
            GhErrorCode::GhUnavailable,
            "The GitHub CLI (gh) is not installed or not on PATH.",
        )
    })?;
    let mut command = tokio::process::Command::new(&gh_path);
    command
        .args(&args)
        .current_dir(repo_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|err| GhError::new(GhErrorCode::GhFailed, err.to_string()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| invalid("Could not open gh's standard input."))?;
    let body_bytes = body.as_bytes().to_vec();
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&body_bytes).await;
        let _ = stdin.shutdown().await;
    });
    let output = tokio::time::timeout(CREATE_TIMEOUT, child.wait_with_output()).await;
    let _ = writer.await;
    let output =
        match output {
            Ok(Ok(output)) => output,
            Ok(Err(err)) => return Err(GhError::new(GhErrorCode::GhFailed, err.to_string())),
            Err(_) => return Err(GhError::new(
                GhErrorCode::Timeout,
                "GitHub did not answer in time; check the GitHub repository's issues before trying again.",
            )),
        };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        return Err(map_gh_failure(&stderr, &stdout));
    }
    parse_created_issue(&stdout, &owner, &repo).ok_or_else(|| {
        GhError::new(
            GhErrorCode::GithubFailed,
            "gh did not report the new issue's address; check the GitHub repository's issues.",
        )
    })
}
