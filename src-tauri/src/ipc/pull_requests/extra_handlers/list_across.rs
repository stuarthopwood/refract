// `pullRequests.listAcross`: one batched `gh search prs` with a `--repo` per distinct owner/repo.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use crate::github::gh::{owner_repo_for, GhError};
use crate::github::gh_issues::clean_search_query;
use crate::github::gh_pr_search_across::{ensure_search_budget, search_across};
use crate::github::gh_pull_requests::{view_check_state, SearchQualifierFlag};
use crate::ipc::{invalid_argument, now_iso8601, AppState, HandlerFuture};

use super::super::mapping::{
    map_actor, map_check_state, map_pull_request_state, PullRequestSummary,
};
use super::super::{
    map_gh_error, parse_filter_tab, repo_path_for, with_bounded_concurrency, FilterTab,
    CHECK_STATE_CONCURRENCY,
};

const MAX_PROJECTS: usize = 40;
const MIN_LIMIT: u64 = 50;
const MAX_LIMIT: u64 = 200;
const RESOLVE_CONCURRENCY: usize = 4;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AcrossItem {
    repository_id: String,
    repository_name: String,
    #[serde(flatten)]
    summary: PullRequestSummary,
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
struct AcrossResult {
    items: Vec<AcrossItem>,
    has_more: bool,
    skipped: Vec<SkippedProject>,
    fetched_at: String,
}

struct Project {
    repository_id: String,
    repository_name: String,
    path: PathBuf,
}

fn skipped_for(project: &Project, err: GhError) -> SkippedProject {
    SkippedProject {
        repository_id: project.repository_id.clone(),
        repository_name: project.repository_name.clone(),
        code: err.code.as_str(),
        message: err.message,
    }
}

/// `pullRequests.listAcross(tab, state, repositoryIds, query, limit)`.
pub(super) fn pull_requests_list_across(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str =
            "pullRequests.listAcross expects (tab, state, repositoryIds, query, limit)";
        let tab = args
            .first()
            .and_then(Value::as_str)
            .and_then(parse_filter_tab)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let gh_state = match args.get(1).and_then(Value::as_str) {
            Some("open") => Some("open"),
            Some("closed") => Some("closed"),
            Some("all") => None,
            _ => return Err(invalid_argument(USAGE)),
        };
        let ids: Vec<String> = args
            .get(2)
            .and_then(Value::as_array)
            .ok_or_else(|| invalid_argument(USAGE))?
            .iter()
            .map(|value| value.as_str().map(str::to_string))
            .collect::<Option<_>>()
            .ok_or_else(|| invalid_argument(USAGE))?;
        if ids.len() > MAX_PROJECTS {
            return Err(invalid_argument("Choose at most 40 projects."));
        }
        let query = args
            .get(3)
            .and_then(Value::as_str)
            .and_then(clean_search_query);
        let limit = args
            .get(4)
            .and_then(Value::as_u64)
            .filter(|n| (MIN_LIMIT..=MAX_LIMIT).contains(n))
            .ok_or_else(|| invalid_argument(USAGE))? as usize;

        let mut skipped: Vec<SkippedProject> = Vec::new();
        let mut projects: Vec<Project> = Vec::new();
        for id in ids {
            // Removed Projects are skipped, not failed.
            match repo_path_for(&state, &id).await {
                Ok((path, name)) => projects.push(Project {
                    repository_id: id,
                    repository_name: name,
                    path,
                }),
                Err(_) => skipped.push(SkippedProject {
                    repository_name: id.clone(),
                    repository_id: id,
                    code: "gh-failed",
                    message: "This project is no longer available.".to_string(),
                }),
            }
        }

        let paths: Vec<PathBuf> = projects.iter().map(|p| p.path.clone()).collect();
        let slugs = with_bounded_concurrency(paths, RESOLVE_CONCURRENCY, |path| async move {
            owner_repo_for(&path)
                .await
                .map(|(owner, repo)| format!("{owner}/{repo}"))
        })
        .await;

        // The first Project on a remote owns its pull requests; the rest list nothing new.
        let mut owner_of: HashMap<String, usize> = HashMap::new();
        let mut distinct: Vec<String> = Vec::new();
        for (index, slug) in slugs.into_iter().enumerate() {
            match slug {
                Ok(slug) => {
                    let key = slug.to_lowercase();
                    if let std::collections::hash_map::Entry::Vacant(slot) = owner_of.entry(key) {
                        slot.insert(index);
                        distinct.push(slug);
                    }
                }
                Err(err) => skipped.push(skipped_for(&projects[index], err)),
            }
        }

        let mut items: Vec<AcrossItem> = Vec::new();
        let mut has_more = false;
        if !distinct.is_empty() {
            let cwd = projects[owner_of[&distinct[0].to_lowercase()]].path.clone();
            ensure_search_budget(&cwd).await.map_err(map_gh_error)?;
            let flag = match tab {
                FilterTab::All => None,
                FilterTab::Authored => Some(SearchQualifierFlag::Author),
                FilterTab::Assigned => Some(SearchQualifierFlag::Assignee),
                FilterTab::Involves => Some(SearchQualifierFlag::Involves),
                FilterTab::ReviewRequested => Some(SearchQualifierFlag::ReviewRequested),
            };
            let entries = search_across(&cwd, &distinct, flag, gh_state, query.as_deref(), limit)
                .await
                .map_err(map_gh_error)?;
            has_more = entries.len() >= limit;

            // The search has no `statusCheckRollup`; only open and draft pull requests show one.
            let work: Vec<(PathBuf, String, u64, String, bool)> = entries
                .iter()
                .map(|e| {
                    let path = owner_of
                        .get(&e.repository.name_with_owner.to_lowercase())
                        .map(|&i| projects[i].path.clone())
                        .unwrap_or_else(|| cwd.clone());
                    (
                        path,
                        e.repository.name_with_owner.clone(),
                        e.number,
                        e.updated_at.clone(),
                        e.state.eq_ignore_ascii_case("open"),
                    )
                })
                .collect();
            let rollups = with_bounded_concurrency(
                work,
                CHECK_STATE_CONCURRENCY,
                |(path, slug, number, updated_at, open)| async move {
                    if !open {
                        return None;
                    }
                    view_check_state(&path, &slug, number, &updated_at)
                        .await
                        .unwrap_or(None)
                },
            )
            .await;

            for (entry, rollup) in entries.into_iter().zip(rollups) {
                let Some(&index) = owner_of.get(&entry.repository.name_with_owner.to_lowercase())
                else {
                    continue;
                };
                let project = &projects[index];
                items.push(AcrossItem {
                    repository_id: project.repository_id.clone(),
                    repository_name: project.repository_name.clone(),
                    summary: PullRequestSummary {
                        number: entry.number,
                        title: entry.title,
                        state: map_pull_request_state(&entry.state, entry.is_draft),
                        check_state: map_check_state(rollup.as_deref()),
                        repository: entry.repository.name_with_owner,
                        updated_at: entry.updated_at,
                        author: map_actor(Some(&entry.author)),
                    },
                });
            }
        }

        let result = AcrossResult {
            items,
            has_more,
            skipped,
            fetched_at: now_iso8601(),
        };
        Ok(serde_json::to_value(result).expect("list result is always JSON-serialisable"))
    })
}
