// Thin handlers over `github/gh_issues.rs`, which validates input; the repo comes from the registry.

use std::collections::HashSet;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::github::gh::{owner_repo_for, GhError};
use crate::github::gh_issue_list::{self, IssueListQuery, IssueRow};
use crate::github::gh_issues;

use super::pull_requests::{map_gh_error, repo_path_for};
use super::{arg_str, invalid_argument, now_iso8601, Dispatcher, HandlerFuture};

/// Caps how many Projects are listed and how many `gh` calls run at once.
const MAX_PROJECTS: usize = 200;
const LIST_CONCURRENCY: usize = 4;

/// One Project's listing: its lower-cased `owner/repo` slug and rows, or why it was skipped.
type ProjectOutcome = Result<(String, Vec<IssueRow>), GhError>;

pub fn register(d: &mut Dispatcher) {
    d.register("issues.labels", issues_labels);
    d.register("issues.search", issues_search);
    d.register("issues.create", issues_create);
    d.register("issues.list", issues_list);
    d.register("issues.view", issues_view);
    d.register(
        "issues.newSession",
        super::session_kickoff::issues_new_session,
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListedIssue {
    repository_id: String,
    repository_name: String,
    #[serde(flatten)]
    row: IssueRow,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkippedProject {
    repository_id: String,
    repository_name: String,
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResult {
    issues: Vec<ListedIssue>,
    skipped: Vec<SkippedProject>,
    fetched_at: String,
}

struct Resolved {
    repository_id: String,
    repository_name: String,
    path: std::path::PathBuf,
}

/// One `gh issue list` per distinct owner/repo, newest first; failures go in `skipped`.
fn issues_list(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str = "issues.list expects (tab, state, repositoryIds, labels, query)";
        let tab = arg_str(&args, 0)
            .and_then(gh_issue_list::parse_tab)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let state_filter = arg_str(&args, 1)
            .and_then(gh_issue_list::parse_state)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let ids: Vec<String> = args
            .get(2)
            .and_then(Value::as_array)
            .ok_or_else(|| invalid_argument(USAGE))?
            .iter()
            .map(|value| value.as_str().map(str::to_string))
            .collect::<Option<_>>()
            .ok_or_else(|| invalid_argument(USAGE))?;
        if ids.len() > MAX_PROJECTS {
            return Err(invalid_argument("Choose at most 200 projects."));
        }
        let labels: Vec<String> = args
            .get(3)
            .and_then(Value::as_array)
            .ok_or_else(|| invalid_argument(USAGE))?
            .iter()
            .map(|value| value.as_str().map(str::to_string))
            .collect::<Option<_>>()
            .ok_or_else(|| invalid_argument(USAGE))?;
        let search = arg_str(&args, 4);
        let query = Arc::new(
            IssueListQuery::new(tab, state_filter, &labels, search).map_err(map_gh_error)?,
        );

        let mut skipped: Vec<SkippedProject> = Vec::new();
        let mut resolved: Vec<Resolved> = Vec::new();
        for id in ids {
            // A Project removed since the last listing is skipped, not failed.
            let Ok((path, name)) = repo_path_for(&state, &id).await else {
                skipped.push(SkippedProject {
                    repository_name: id.clone(),
                    repository_id: id,
                    code: "gh-failed",
                    message: "This project is no longer available.".to_string(),
                });
                continue;
            };
            resolved.push(Resolved {
                repository_id: id,
                repository_name: name,
                path,
            });
        }

        let semaphore = Arc::new(tokio::sync::Semaphore::new(LIST_CONCURRENCY));
        let mut seen: HashSet<String> = HashSet::new();
        let mut tasks = tokio::task::JoinSet::new();
        for (index, project) in resolved.iter().enumerate() {
            let path = project.path.clone();
            let query = Arc::clone(&query);
            let semaphore = Arc::clone(&semaphore);
            // Duplicate slugs are dropped when their result comes back.
            tasks.spawn(async move {
                let _permit = semaphore.acquire_owned().await.ok();
                let outcome: ProjectOutcome = async {
                    let (owner, repo) = owner_repo_for(&path).await?;
                    let rows = gh_issue_list::list_issues(&path, &owner, &repo, &query).await?;
                    Ok((format!("{owner}/{repo}").to_lowercase(), rows))
                }
                .await;
                (index, outcome)
            });
        }
        let mut outcomes: Vec<(usize, ProjectOutcome)> = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            if let Ok(outcome) = joined {
                outcomes.push(outcome);
            }
        }
        outcomes.sort_by_key(|(index, _)| *index);

        let mut issues: Vec<ListedIssue> = Vec::new();
        for (index, outcome) in outcomes {
            let project = &resolved[index];
            match outcome {
                Ok((slug, rows)) => {
                    if !seen.insert(slug) {
                        continue;
                    }
                    issues.extend(rows.into_iter().map(|row| ListedIssue {
                        repository_id: project.repository_id.clone(),
                        repository_name: project.repository_name.clone(),
                        row,
                    }));
                }
                Err(err) => skipped.push(SkippedProject {
                    repository_id: project.repository_id.clone(),
                    repository_name: project.repository_name.clone(),
                    code: err.code.as_str(),
                    message: err.message,
                }),
            }
        }
        issues.sort_by(|a, b| b.row.updated_at.cmp(&a.row.updated_at));
        let result = ListResult {
            issues,
            skipped,
            fetched_at: now_iso8601(),
        };
        Ok(serde_json::to_value(result).expect("list result is always JSON-serialisable"))
    })
}

fn issues_view(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str = "issues.view expects (repositoryId, number)";
        let repository_id = arg_str(&args, 0).ok_or_else(|| invalid_argument(USAGE))?;
        let number = args
            .get(1)
            .and_then(Value::as_u64)
            .filter(|&n| n > 0 && n <= i32::MAX as u64)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let detail = gh_issue_list::view_issue(&repo_path, number)
            .await
            .map_err(map_gh_error)?;
        Ok(serde_json::to_value(detail).expect("issue detail is always JSON-serialisable"))
    })
}

fn issues_labels(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = arg_str(&args, 0)
            .ok_or_else(|| invalid_argument("issues.labels expects (repositoryId)"))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let labels = gh_issues::list_labels(&repo_path)
            .await
            .map_err(map_gh_error)?;
        Ok(serde_json::to_value(labels).expect("labels are always JSON-serialisable"))
    })
}

fn issues_search(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str = "issues.search expects (repositoryId, query)";
        let repository_id = arg_str(&args, 0).ok_or_else(|| invalid_argument(USAGE))?;
        let query = arg_str(&args, 1).ok_or_else(|| invalid_argument(USAGE))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let matches = gh_issues::search_issues(&repo_path, query)
            .await
            .map_err(map_gh_error)?;
        Ok(serde_json::to_value(matches).expect("matches are always JSON-serialisable"))
    })
}

fn issues_create(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str = "issues.create expects (repositoryId, title, body, labels)";
        let repository_id = arg_str(&args, 0).ok_or_else(|| invalid_argument(USAGE))?;
        let title = arg_str(&args, 1).ok_or_else(|| invalid_argument(USAGE))?;
        let body = arg_str(&args, 2).ok_or_else(|| invalid_argument(USAGE))?;
        let labels: Vec<String> = args
            .get(3)
            .and_then(Value::as_array)
            .ok_or_else(|| invalid_argument(USAGE))?
            .iter()
            .map(|value| value.as_str().map(str::to_string))
            .collect::<Option<_>>()
            .ok_or_else(|| invalid_argument(USAGE))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let created = gh_issues::create_issue(&repo_path, title, body, &labels)
            .await
            .map_err(map_gh_error)?;
        Ok(serde_json::to_value(created).expect("created issue is always JSON-serialisable"))
    })
}
