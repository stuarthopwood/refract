// `issues.*` (issue #503, spec 049): "Report an issue". Thin handlers over
// `github/gh_issues.rs`; every input is validated there before it reaches `gh`, and the
// repository is always resolved from the registry, never from a renderer-supplied path.

use serde_json::Value;

use crate::github::gh_issues;

use super::pull_requests::{map_gh_error, repo_path_for};
use super::{arg_str, invalid_argument, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("issues.labels", issues_labels);
    d.register("issues.search", issues_search);
    d.register("issues.create", issues_create);
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
