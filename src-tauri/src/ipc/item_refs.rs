// `itemRefs.lookup` (#1155): the Item card behind a `#123` / `owner/repo#123` hover. The Project only
// supplies the clone `gh` runs in and the default repository for a bare `#123`.
// `itemRefs.search` (#1789): the composer `#` picker's rows, always for the Project's own repository.

use std::sync::Mutex;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::github::gh::{owner_repo_for, GhError, GhErrorCode};
use crate::github::item_ref::{lookup_item, search_items, valid_item_number, RepoSlug};

use super::pull_requests::{map_gh_error, repo_path_for};
use super::{arg_str, invalid_argument, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("itemRefs.lookup", item_refs_lookup);
    d.register("itemRefs.search", item_refs_search);
}

fn item_refs_lookup(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str =
            "itemRefs.lookup expects (repositoryId, owner | null, repo | null, number)";
        let repository_id = arg_str(&args, 0).ok_or_else(|| invalid_argument(USAGE))?;
        let number = args
            .get(3)
            .and_then(Value::as_u64)
            .filter(|&n| valid_item_number(n))
            .ok_or_else(|| invalid_argument(USAGE))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let slug = match (arg_str(&args, 1), arg_str(&args, 2)) {
            (Some(owner), Some(repo)) => RepoSlug::parse(owner, repo).map_err(map_gh_error)?,
            (None, None) => {
                let (owner, repo) = owner_repo_for(&repo_path).await.map_err(map_gh_error)?;
                RepoSlug::parse(&owner, &repo).map_err(map_gh_error)?
            }
            _ => return Err(invalid_argument(USAGE)),
        };
        let card = lookup_item(&repo_path, &slug, number)
            .await
            .map_err(map_gh_error)?;
        Ok(serde_json::to_value(card).expect("item card is always JSON-serialisable"))
    })
}

/// A typed query is a few characters; this stops a pasted blob crossing IPC before the backend trims it.
const MAX_SEARCH_ARG_CHARS: usize = 200;

/// Cancels the search in flight: storing a new sender drops the old one, which wakes its `select!`.
static SEARCH_CANCEL: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

fn item_refs_search(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str = "itemRefs.search expects (repositoryId, query)";
        let repository_id = arg_str(&args, 0).ok_or_else(|| invalid_argument(USAGE))?;
        let query = arg_str(&args, 1)
            .filter(|q| q.chars().count() <= MAX_SEARCH_ARG_CHARS)
            .ok_or_else(|| invalid_argument(USAGE))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        // Cached per clone, so only the first search of a Project runs `git remote`.
        let (owner, repo) = owner_repo_for(&repo_path).await.map_err(map_gh_error)?;
        let slug = RepoSlug::parse(&owner, &repo).map_err(map_gh_error)?;
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        *SEARCH_CANCEL.lock().expect("search cancel mutex poisoned") = Some(cancel_tx);
        // Dropping the losing future kills its `gh` child (kill_on_drop), so typing never stacks searches.
        let rows = tokio::select! {
            found = search_items(&repo_path, &slug, query) => found.map_err(map_gh_error)?,
            _ = cancel_rx => {
                return Err(map_gh_error(GhError::new(
                    GhErrorCode::GithubFailed,
                    "Search superseded by a newer one.",
                )))
            }
        };
        Ok(serde_json::to_value(rows).expect("item summaries are always JSON-serialisable"))
    })
}
