// `home.*` (issue #869, spec 059: the Home view). Thin handlers: the Session and repository are
// always resolved from the registry, never from a renderer-supplied path.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::github::gh::{owner_repo_for, GhError};
use crate::github::gh_closed_branches::{self, ClosedBranchRow};
use crate::session::last_user_message::read_last_user_line;
use crate::session::saved_history::contained_history_file;

use super::pull_requests::repo_path_for;
use super::{invalid_argument, now_iso8601, Dispatcher, HandlerFuture};

const MAX_SESSIONS: usize = 8;
const MAX_PROJECTS: usize = 40;
const LIST_CONCURRENCY: usize = 4;

type ProjectOutcome = Result<Vec<ClosedBranchRow>, GhError>;

pub fn register(d: &mut Dispatcher) {
    d.register("home.lastMessages", home_last_messages);
    d.register("home.closedBranches", home_closed_branches);
}

fn string_array(args: &[Value], usage: &str) -> Result<Vec<String>, super::IpcError> {
    args.first()
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_argument(usage))?
        .iter()
        .map(|value| value.as_str().map(str::to_string))
        .collect::<Option<_>>()
        .ok_or_else(|| invalid_argument(usage))
}

/// `home.lastMessages(sessionIds)`: the last user prompt of each Session's contained current
/// Conversation, one line, or null. At most 8 ids.
fn home_last_messages(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let ids = string_array(&args, "home.lastMessages expects (sessionIds)")?;
        if ids.len() > MAX_SESSIONS {
            return Err(invalid_argument(format!("Ask for at most {MAX_SESSIONS} sessions.")));
        }
        let mut result = Map::new();
        for id in ids {
            let (dir, file) = {
                let registry = state.registry.lock().await;
                match registry.get_session(&id) {
                    Some(session) => (
                        session.session_dir.clone(),
                        session.current_conversation.clone(),
                    ),
                    None => (None, None),
                }
            };
            let line = match contained_history_file(dir.as_deref(), file.as_deref()).await {
                Some(path) => read_last_user_line(&path).await,
                None => None,
            };
            result.insert(id, line.map_or(Value::Null, Value::String));
        }
        Ok(Value::Object(result))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedItem {
    repository_id: String,
    #[serde(flatten)]
    row: ClosedBranchRow,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Skipped {
    repository_id: String,
    repository_name: String,
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedResult {
    items: Vec<ClosedItem>,
    skipped: Vec<Skipped>,
    fetched_at: String,
}

/// `home.closedBranches(repositoryIds)`: one `gh pr list` per Project, so Projects sharing a
/// remote each get the rows. A Project that fails (no GitHub remote, rate limit) is reported in `skipped`, never as a blank.
fn home_closed_branches(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let ids = string_array(&args, "home.closedBranches expects (repositoryIds)")?;
        if ids.len() > MAX_PROJECTS {
            return Err(invalid_argument(format!("Choose at most {MAX_PROJECTS} projects.")));
        }
        let mut skipped: Vec<Skipped> = Vec::new();
        let mut resolved: Vec<(String, String, std::path::PathBuf)> = Vec::new();
        for id in ids {
            match repo_path_for(&state, &id).await {
                Ok((path, name)) => resolved.push((id, name, path)),
                Err(_) => skipped.push(Skipped {
                    repository_name: id.clone(),
                    repository_id: id,
                    code: "gh-failed",
                    message: "This project is no longer available.".to_string(),
                }),
            }
        }
        let semaphore = Arc::new(tokio::sync::Semaphore::new(LIST_CONCURRENCY));
        let mut tasks = tokio::task::JoinSet::new();
        let mut task_index: HashMap<tokio::task::Id, usize> = HashMap::new();
        for (index, (_, _, path)) in resolved.iter().enumerate() {
            let path = path.clone();
            let semaphore = Arc::clone(&semaphore);
            let handle = tasks.spawn(async move {
                let _permit = semaphore.acquire_owned().await.ok();
                let outcome: ProjectOutcome = async {
                    let (owner, repo) = owner_repo_for(&path).await?;
                    gh_closed_branches::list_closed_branches(&path, &owner, &repo).await
                }
                .await;
                outcome
            });
            task_index.insert(handle.id(), index);
        }
        let mut outcomes: Vec<(usize, ProjectOutcome)> = Vec::new();
        while let Some(joined) = tasks.join_next_with_id().await {
            match joined {
                Ok((task, outcome)) => {
                    if let Some(index) = task_index.get(&task) {
                        outcomes.push((*index, outcome));
                    }
                }
                Err(err) => {
                    if let Some(index) = task_index.get(&err.id()) {
                        let (id, name, _) = &resolved[*index];
                        skipped.push(Skipped {
                            repository_id: id.clone(),
                            repository_name: name.clone(),
                            code: "gh-failed",
                            message: "Loading this project's pull requests failed.".to_string(),
                        });
                    }
                }
            }
        }
        outcomes.sort_by_key(|(index, _)| *index);
        let mut items: Vec<ClosedItem> = Vec::new();
        for (index, outcome) in outcomes {
            let (id, name, _) = &resolved[index];
            match outcome {
                Ok(rows) => {
                    items.extend(rows.into_iter().map(|row| ClosedItem {
                        repository_id: id.clone(),
                        row,
                    }));
                }
                Err(err) => skipped.push(Skipped {
                    repository_id: id.clone(),
                    repository_name: name.clone(),
                    code: err.code.as_str(),
                    message: err.message,
                }),
            }
        }
        let result = ClosedResult {
            items,
            skipped,
            fetched_at: now_iso8601(),
        };
        Ok(serde_json::to_value(result).expect("closed result is always JSON-serialisable"))
    })
}
