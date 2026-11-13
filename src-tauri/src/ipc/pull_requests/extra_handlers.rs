// IPC handlers for `pullRequests.close` and `pullRequests.fetchImage`.

use serde_json::Value;

mod list_across;
mod stack_refs;

use crate::github::gh_close::close_pull_request_mutation;
use crate::github::images::fetch_pr_image;
use crate::ipc::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

use super::{
    check_not_stale, forget_cache, map_gh_error, notify_changed, repo_path_for, stale_error,
    valid_pull_request_number, STALE_ERROR,
};

pub(super) fn register(d: &mut Dispatcher) {
    d.register("pullRequests.close", pull_requests_close);
    d.register("pullRequests.fetchImage", pull_requests_fetch_image);
    d.register(
        "pullRequests.listAcross",
        list_across::pull_requests_list_across,
    );
    d.register(
        "pullRequests.stackRefs",
        stack_refs::pull_requests_stack_refs,
    );
}

/// Closes without merging; refuses a pull request that changed since the renderer last loaded it.
pub(super) fn pull_requests_close(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str = "pullRequests.close expects (repositoryId, number)";
        let repository_id = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let number = valid_pull_request_number(&args, 1).ok_or_else(|| invalid_argument(USAGE))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let (stale, fresh) = check_not_stale(repository_id, &repo_path, number, false)
            .await
            .map_err(map_gh_error)?;
        if stale {
            return Err(stale_error(STALE_ERROR));
        }
        close_pull_request_mutation(&repo_path, &fresh.id)
            .await
            .map_err(map_gh_error)?;
        forget_cache(repository_id, number);
        notify_changed(&state, repository_id, number);
        Ok(serde_json::json!({}))
    })
}

pub(super) fn pull_requests_fetch_image(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let url = args
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_argument("pullRequests.fetchImage expects (url)"))?;
        let data_url = fetch_pr_image(url)
            .await
            .map_err(|err| IpcError::new("image-failed", err.message))?;
        Ok(serde_json::json!({ "dataUrl": data_url }))
    })
}
