// `repositories.listGitHub`, `repositories.clone`, `repositories.cloneCancel` and their progress event.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{mpsc::UnboundedReceiver, Mutex, Semaphore};
use tokio::task::JoinSet;

use crate::events::{self, REPOSITORIES_CLONE_PROGRESS};
use crate::github::clone_destination::{self, path_key, DestinationError};
use crate::github::gh::{GhError, GhErrorCode};
use crate::github::repo_clone::{CloneEvent, CloneJob};
use crate::github::repo_list::{list_orgs, list_owner_repos, signed_in_logins, RepoListItem};
use crate::github::repo_match::project_index;
use crate::github::repo_ref::{is_valid_owner, parse_source};

use super::repositories::add_repository_at;
use super::{arg_str, invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

const MAX_RUNNING_CLONES: usize = 4;
const LIST_CONCURRENCY: usize = 4;
const FIRST_EMIT_DELAY: Duration = Duration::from_millis(150);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(12);

struct Entry {
    job: Arc<CloneJob>,
    destination_key: String,
}

static RUNNING: LazyLock<Mutex<HashMap<String, Entry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn register(d: &mut Dispatcher) {
    d.register("repositories.listGitHub", repositories_list_github);
    d.register("repositories.clone", repositories_clone);
    d.register("repositories.cloneCancel", repositories_clone_cancel);
}

fn gh_ipc_error(err: &GhError) -> IpcError {
    match err.code {
        GhErrorCode::GhUnavailable | GhErrorCode::GhNotFound => {
            IpcError::new("gh-unavailable", err.message.clone())
        }
        code => IpcError::new(code.as_str(), err.message.clone()),
    }
}

fn row_json(item: &RepoListItem, index: &HashMap<String, String>) -> Value {
    json!({
        "nameWithOwner": item.name_with_owner,
        "description": item.description,
        "isPrivate": item.is_private,
        "updatedAt": item.updated_at,
        "existingProjectId": index.get(&item.name_with_owner.to_lowercase()),
    })
}

async fn owner_listing(
    owner: String,
    kind: &'static str,
    index: &HashMap<String, String>,
) -> Value {
    match list_owner_repos(&owner).await {
        Ok(items) => {
            let repos: Vec<Value> = items.iter().map(|item| row_json(item, index)).collect();
            json!({ "owner": owner, "kind": kind, "repos": repos, "error": Value::Null })
        }
        Err(err) => json!({
            "owner": owner,
            "kind": kind,
            "repos": [],
            "error": { "code": err.code.as_str(), "message": err.message },
        }),
    }
}

pub fn repositories_list_github(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let only_owner = match args.first() {
            None | Some(Value::Null) => None,
            Some(Value::String(owner)) if is_valid_owner(owner) => Some(owner.clone()),
            Some(_) => {
                return Err(invalid_argument(
                    "repositories.listGitHub expects a valid GitHub owner name",
                ))
            }
        };
        let logins = signed_in_logins().await.map_err(|err| gh_ipc_error(&err))?;
        if logins.is_empty() {
            return Ok(json!({ "signedIn": false, "owners": [] }));
        }

        let mut owners: Vec<(String, &'static str)> = Vec::new();
        match &only_owner {
            Some(owner) => {
                let is_self = logins.iter().any(|login| login.eq_ignore_ascii_case(owner));
                owners.push((owner.clone(), if is_self { "self" } else { "org" }));
            }
            None => {
                owners.extend(logins.iter().map(|login| (login.clone(), "self")));
                for org in list_orgs().await.unwrap_or_default() {
                    if !owners.iter().any(|(o, _)| o.eq_ignore_ascii_case(&org)) {
                        owners.push((org, "org"));
                    }
                }
            }
        }

        let repositories = state.registry.lock().await.snapshot().repositories;
        let index = Arc::new(project_index(&repositories).await);
        let permits = Arc::new(Semaphore::new(LIST_CONCURRENCY));
        let mut tasks = JoinSet::new();
        for (position, (owner, kind)) in owners.into_iter().enumerate() {
            let index = index.clone();
            let permits = permits.clone();
            tasks.spawn(async move {
                let _permit = permits.acquire_owned().await;
                (position, owner_listing(owner, kind, &index).await)
            });
        }
        let mut listings: Vec<(usize, Value)> = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            if let Ok(listing) = joined {
                listings.push(listing);
            }
        }
        listings.sort_by_key(|(position, _)| *position);
        let owners: Vec<Value> = listings.into_iter().map(|(_, listing)| listing).collect();
        Ok(json!({ "signedIn": true, "owners": owners }))
    })
}

pub fn repositories_clone(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let request = args.first().and_then(Value::as_object);
        let source = request
            .and_then(|r| r.get("source"))
            .and_then(Value::as_str);
        let destination = request
            .and_then(|r| r.get("destination"))
            .and_then(Value::as_str);
        let (Some(source), Some(destination)) = (source, destination) else {
            return Err(invalid_argument(
                "repositories.clone expects {source, destination} strings",
            ));
        };
        let repo = parse_source(source).map_err(invalid_argument)?;
        let name_with_owner = repo.name_with_owner();

        let repositories = state.registry.lock().await.snapshot().repositories;
        let index = project_index(&repositories).await;
        if let Some(project_id) = index.get(&name_with_owner.to_lowercase()) {
            return Ok(json!({ "kind": "existing", "projectId": project_id }));
        }

        let project_paths: Vec<String> = repositories.iter().map(|r| r.path.clone()).collect();
        let destination = clone_destination::validate(destination, &project_paths)
            .await
            .map_err(|err| match err {
                DestinationError::NotEmpty => {
                    IpcError::new("destination-not-empty", err.message().to_string())
                }
                DestinationError::Invalid(_) => invalid_argument(err.message().to_string()),
            })?;
        let destination_key = path_key(&destination.path);

        let mut running = RUNNING.lock().await;
        if running.len() >= MAX_RUNNING_CLONES {
            return Err(IpcError::new(
                "too-many-clones",
                "Too many clones are running. Wait for one to finish.",
            ));
        }
        let nested = |a: &str, b: &str| {
            a == b || a.starts_with(&format!("{b}\\")) || b.starts_with(&format!("{a}\\"))
        };
        if running
            .values()
            .any(|e| nested(&e.destination_key, &destination_key))
        {
            return Err(IpcError::new(
                "destination-in-use",
                "Another clone is already using that folder.",
            ));
        }
        // Exclusive create, so cleanup only ever removes a folder this attempt made.
        let created_by_us = if destination.existed {
            false
        } else {
            clone_destination::create_exclusive(&destination.path)
                .await
                .map_err(|err| match err {
                    DestinationError::NotEmpty => {
                        IpcError::new("destination-not-empty", err.message().to_string())
                    }
                    DestinationError::Invalid(_) => invalid_argument(err.message().to_string()),
                })?;
            true
        };
        let (job, events) = match CloneJob::start(&repo, &destination.path).await {
            Ok(started) => started,
            Err(err) => {
                if created_by_us {
                    clone_destination::remove_created(&destination.path, &project_paths).await;
                }
                return Err(gh_ipc_error(&err));
            }
        };
        let clone_id = uuid::Uuid::new_v4().to_string();
        running.insert(
            clone_id.clone(),
            Entry {
                job,
                destination_key,
            },
        );
        drop(running);

        let path_text = destination.path.to_string_lossy().into_owned();
        tokio::spawn(supervise(
            state,
            clone_id.clone(),
            events,
            destination.path,
            created_by_us,
        ));
        Ok(json!({
            "kind": "started",
            "cloneId": clone_id,
            "nameWithOwner": name_with_owner,
            "destination": path_text,
        }))
    })
}

pub fn repositories_clone_cancel(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(clone_id) = arg_str(&args, 0) else {
            return Err(invalid_argument(
                "repositories.cloneCancel expects a string cloneId",
            ));
        };
        let job = RUNNING.lock().await.get(clone_id).map(|e| e.job.clone());
        if let Some(job) = job {
            job.cancel().await;
        }
        Ok(Value::Null)
    })
}

/// Cancels running clones on app exit, so a quit never leaves a half-cloned folder.
pub async fn shutdown_all() {
    let jobs: Vec<Arc<CloneJob>> = RUNNING
        .lock()
        .await
        .values()
        .map(|e| e.job.clone())
        .collect();
    if jobs.is_empty() {
        return;
    }
    let _ = tokio::time::timeout(SHUTDOWN_WAIT, async {
        for job in &jobs {
            job.cancel().await;
        }
        while !RUNNING.lock().await.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
}

fn emit_event(state: &AppState, payload: Value) {
    let handle = state
        .app_handle
        .lock()
        .expect("app_handle mutex poisoned")
        .clone();
    if let Some(handle) = handle {
        events::emit(&handle, REPOSITORIES_CLONE_PROGRESS, payload);
    }
}

fn progress_payload(clone_id: &str, stage: &str, percent: Option<u8>) -> Value {
    json!({ "cloneId": clone_id, "phase": "progress", "stage": stage, "percent": percent })
}

/// Removes the folder this attempt created; returns the path if removal failed.
/// A pre-existing empty destination is never touched.
async fn clean_up(state: &AppState, destination: &Path, created_by_us: bool) -> Option<String> {
    if !created_by_us {
        return None;
    }
    let project_paths: Vec<String> = state
        .registry
        .lock()
        .await
        .snapshot()
        .repositories
        .iter()
        .map(|r| r.path.clone())
        .collect();
    if clone_destination::remove_created(destination, &project_paths).await {
        None
    } else {
        Some(destination.to_string_lossy().into_owned())
    }
}

async fn supervise(
    state: AppState,
    clone_id: String,
    mut events: UnboundedReceiver<CloneEvent>,
    destination: PathBuf,
    created_by_us: bool,
) {
    // The cloneId arrives in the start reply, before the first event.
    tokio::time::sleep(FIRST_EMIT_DELAY).await;
    let mut last_stage = "";
    let mut last_emit = Instant::now();
    let mut exit = None;
    while let Some(event) = events.recv().await {
        match event {
            CloneEvent::Progress(progress) => {
                let stage = progress.stage.as_str();
                if stage != last_stage || last_emit.elapsed() >= PROGRESS_INTERVAL {
                    last_stage = stage;
                    last_emit = Instant::now();
                    emit_event(&state, progress_payload(&clone_id, stage, progress.percent));
                }
            }
            CloneEvent::Exit(done) => {
                exit = Some(done);
                break;
            }
        }
    }

    let destination_text = destination.to_string_lossy().into_owned();
    let payload = match exit {
        Some(done) if done.code == Some(0) => {
            emit_event(&state, progress_payload(&clone_id, "adding", None));
            match add_repository_at(&state, &destination_text).await {
                Ok(project) => json!({ "cloneId": clone_id, "phase": "done", "project": project }),
                Err(_) => json!({
                    "cloneId": clone_id,
                    "phase": "done-not-added",
                    "destination": destination_text,
                    "message": format!(
                        "Cloned to {destination_text}, but couldn't add it as a project. Use Add project > Local folder."
                    ),
                }),
            }
        }
        Some(done) if done.requested => {
            let failed = clean_up(&state, &destination, created_by_us).await;
            json!({ "cloneId": clone_id, "phase": "cancelled", "cleanupFailedPath": failed })
        }
        other => {
            let failure = other
                .map(|done| done.failure)
                .unwrap_or(crate::github::repo_clone::CloneFailure::Unknown);
            let failed = clean_up(&state, &destination, created_by_us).await;
            let mut message = failure.message().to_string();
            if let Some(path) = failed {
                message.push_str(&format!(" Refract couldn't remove {path}."));
            }
            json!({
                "cloneId": clone_id,
                "phase": "failed",
                "code": failure.as_str(),
                "message": message,
            })
        }
    };
    RUNNING.lock().await.remove(&clone_id);
    emit_event(&state, payload);
}
