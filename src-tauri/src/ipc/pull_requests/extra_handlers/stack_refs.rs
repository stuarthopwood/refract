// `pullRequests.stackRefs(repositoryId)`: the open pull requests' branch names, so the renderer can
// chain stacks (#1867); the search behind `listAcross` carries no branch fields.

use serde::Serialize;
use serde_json::Value;

use crate::github::gh_pull_requests::list_pull_requests_by_state;
use crate::ipc::{invalid_argument, AppState, HandlerFuture};

use super::super::{map_gh_error, repo_path_for};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StackRef {
    number: u64,
    head_ref: String,
    base_ref: String,
}

pub(super) fn pull_requests_stack_refs(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let repository_id = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_argument("pullRequests.stackRefs expects (repositoryId)"))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let entries = list_pull_requests_by_state(&repo_path, "open")
            .await
            .map_err(map_gh_error)?;
        let refs: Vec<StackRef> = entries
            .into_iter()
            .map(|entry| StackRef {
                number: entry.number,
                head_ref: entry.head_ref_name,
                base_ref: entry.base_ref_name,
            })
            .collect();
        Ok(serde_json::json!({ "items": refs }))
    })
}
