// Readout glue for the touched list: frame hook, history rebuild, and the lazy state refresh.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::github::gh::owner_repo_for;

use super::{now_ms, readout_pr, schedule_readout_update};
use crate::session::agent::SessionAgent;
use crate::session::github_writes::touched::TouchedList;
use crate::session::github_writes::{
    detect, detect_in_history, join_text, GithubWrite, ToolCallRecord, WriteAction, WriteKind,
};

/// Start-frame arguments kept until the matching end frame; the oldest drop first.
const STASH_CAP: usize = 64;
/// A finished item is looked up again after this long (the readout polls about once a minute).
const REFRESH_TTL_MS: i64 = 60_000;
/// Lookups spawned per recompute, newest items first, so a burst of writes cannot flood `gh`.
const MAX_LOOKUPS_PER_RECOMPUTE: usize = 5;

/// Touched-list state held inside the readout `State`.
#[derive(Default)]
pub(super) struct TouchedState {
    list: TouchedList,
    stash: HashMap<String, (String, Value)>,
    stash_order: VecDeque<String>,
}

impl TouchedState {
    pub(super) fn json(&self) -> Option<Value> {
        self.list.to_json()
    }

    /// Drops the list and any half-seen calls when the Conversation changes.
    pub(super) fn reset(&mut self) {
        self.list.clear();
        self.stash.clear();
        self.stash_order.clear();
    }

    fn stash_args(&mut self, id: String, tool: String, args: Value) {
        if self.stash.insert(id.clone(), (tool, args)).is_none() {
            self.stash_order.push_back(id);
        }
        while self.stash_order.len() > STASH_CAP {
            if let Some(old) = self.stash_order.pop_front() {
                self.stash.remove(&old);
            }
        }
    }

    fn take_args(&mut self, id: &str) -> Option<(String, Value)> {
        self.stash_order.retain(|i| i != id);
        self.stash.remove(id)
    }
}

/// Stashes bash and eval arguments at start and detects writes at end.
pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    let tool = frame.get("toolName").and_then(Value::as_str).unwrap_or("");
    if !matches!(tool, "bash" | "eval") {
        return;
    }
    let Some(id) = frame.get("toolCallId").and_then(Value::as_str) else {
        return;
    };
    match frame_type {
        "tool_execution_start" => {
            let args = frame.get("args").cloned().unwrap_or(Value::Null);
            let (id, tool) = (id.to_string(), tool.to_string());
            agent
                .with_readout_state(|s| s.touched.stash_args(id, tool, args))
                .await;
        }
        "tool_execution_end" => {
            let id = id.to_string();
            let Some((tool, args)) = agent.with_readout_state(|s| s.touched.take_args(&id)).await
            else {
                return;
            };
            let result = frame.get("result");
            let output = result
                .and_then(|r| r.get("content"))
                .map(join_text)
                .unwrap_or_default();
            let is_error = frame.get("isError").and_then(Value::as_bool) == Some(true);
            let writes = detect(&ToolCallRecord {
                tool: &tool,
                args: &args,
                output: &output,
                is_error,
                at_ms: now_ms(),
            });
            record_writes(agent, writes).await;
        }
        _ => {}
    }
}

/// Single fan-out point for live writes: updates the list and schedules a readout update.
async fn record_writes(agent: &SessionAgent, writes: Vec<GithubWrite>) {
    if writes.is_empty() {
        return;
    }
    let resolved = resolve_repos(agent, writes).await;
    agent
        .with_readout_state(|s| {
            for (owner, name, kind, number, at, _) in &resolved {
                s.touched.list.touch(owner, name, *kind, *number, *at);
            }
        })
        .await;
    emit_changed(agent, &resolved).await;
    schedule_readout_update(agent).await;
}

/// Tells the renderer to refresh its PR and issue lists; a comment changes neither, so it is skipped.
async fn emit_changed(agent: &SessionAgent, resolved: &[Resolved]) {
    if resolved.iter().all(|r| matches!(r.5, WriteAction::Comment)) {
        return;
    }
    let project_ids = project_ids_by_repo(agent).await;
    for (owner, name, kind, number, _, action) in resolved {
        if matches!(action, WriteAction::Comment) {
            continue;
        }
        let repository_id = project_ids.get(&format!("{owner}/{name}").to_ascii_lowercase());
        let kind = match kind {
            WriteKind::Pr => "pr",
            WriteKind::Issue => "issue",
        };
        agent
            .events()
            .emit_github_changed(repository_id.map(String::as_str), kind, *number);
    }
}

/// Replaces the list from a saved history, so it survives restart and reopening a Conversation.
pub(super) async fn rebuild_from_history(agent: &SessionAgent, history: &[Value]) {
    let writes = detect_in_history(history);
    let resolved = resolve_repos(agent, writes).await;
    agent
        .with_readout_state(|s| {
            s.touched.list.clear();
            for (owner, name, kind, number, at, _) in &resolved {
                s.touched.list.touch(owner, name, *kind, *number, *at);
            }
        })
        .await;
    schedule_readout_update(agent).await;
}

type Resolved = (String, String, WriteKind, u64, i64, WriteAction);

/// Fills a missing repo from the Session worktree's origin; writes with no resolvable repo drop.
async fn resolve_repos(agent: &SessionAgent, writes: Vec<GithubWrite>) -> Vec<Resolved> {
    let mut session_repo: Option<Option<(String, String)>> = None;
    let mut out = Vec::with_capacity(writes.len());
    for w in writes {
        let repo = match w.repo {
            Some(r) => Some(r),
            None => {
                if session_repo.is_none() {
                    let path = session_worktree(agent).await;
                    session_repo = Some(match path {
                        Some(p) => owner_repo_for(Path::new(&p)).await.ok(),
                        None => None,
                    });
                }
                session_repo.clone().flatten()
            }
        };
        if let Some((owner, name)) = repo {
            out.push((owner, name, w.kind, w.number, w.at_ms, w.action));
        }
    }
    out
}

async fn session_worktree(agent: &SessionAgent) -> Option<String> {
    agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .map(|s| s.worktree_path.clone())
}

/// Called once per recompute: matches items to registered Projects and spawns bounded state lookups.
pub(super) async fn refresh(agent: &Arc<SessionAgent>, worktree_path: &str) {
    if agent
        .with_readout_state(|s| s.touched.list.is_empty())
        .await
    {
        return;
    }
    let project_ids = project_ids_by_repo(agent).await;
    let now = now_ms();
    let jobs: Vec<(String, String, u64)> = agent
        .with_readout_state(|s| {
            let mut jobs = Vec::new();
            for item in s.touched.list.items_mut() {
                item.repository_id = project_ids
                    .get(&format!("{}/{}", item.owner, item.name).to_ascii_lowercase())
                    .cloned();
                let stale = item.fetched_at == 0
                    || item.last_touched_at > item.fetched_at
                    || (item.state != "merged" && now - item.fetched_at >= REFRESH_TTL_MS);
                if stale && !item.in_flight && jobs.len() < MAX_LOOKUPS_PER_RECOMPUTE {
                    item.in_flight = true;
                    jobs.push((item.owner.clone(), item.name.clone(), item.number));
                }
            }
            jobs
        })
        .await;
    for (owner, name, number) in jobs {
        let agent = agent.clone();
        let cwd = worktree_path.to_string();
        tokio::spawn(async move {
            let info = readout_pr::item_by_number(Path::new(&cwd), &owner, &name, number).await;
            let finished_at = now_ms();
            agent
                .with_readout_state(|s| {
                    let found = s
                        .touched
                        .list
                        .items_mut()
                        .iter_mut()
                        .find(|i| i.number == number && i.owner == owner && i.name == name);
                    if let Some(item) = found {
                        item.in_flight = false;
                        // Stamped even on failure so a broken `gh` is retried on the TTL, not every recompute.
                        item.fetched_at = finished_at;
                        if let Some(info) = info {
                            item.kind = if info.is_pr {
                                WriteKind::Pr
                            } else {
                                WriteKind::Issue
                            };
                            item.title = info.title;
                            item.state = info.state;
                            if let Some(url) = info.url {
                                item.url = url;
                            }
                        }
                    }
                })
                .await;
            schedule_readout_update(&agent).await;
        });
    }
}

/// Lower-cased `owner/repo` to registered Project id, via the cached `owner_repo_for`.
async fn project_ids_by_repo(agent: &SessionAgent) -> HashMap<String, String> {
    let repositories = agent.registry().lock().await.snapshot().repositories;
    let mut map = HashMap::new();
    for repository in repositories {
        if let Ok((owner, name)) = owner_repo_for(Path::new(&repository.path)).await {
            map.entry(format!("{owner}/{name}").to_ascii_lowercase())
                .or_insert(repository.id);
        }
    }
    map
}
