// Runs the one `tiny` synthesis per live `task()` call and applies it to the Subagents cards (ADR 0013 Q3 to Q5).
// History replay never reaches `handle_task_start`, so a replayed card is labelled from the cache or not at all.

use std::collections::HashSet;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;
use tokio::sync::{OnceCell, Semaphore};

use super::{emit_subagents_update, read_task_specs, subagent_name_or_task, summaries_to_value};
use crate::ipc::model_roles::get_model_roles_reliable_with;
use crate::omp::config::{OmpExecutor, RealOmpExecutor};
use crate::omp::transcript::synthesis_labels::SynthesisLookup;
use crate::session::agent::SessionAgent;
use crate::session::subagents_synthesis::{
    resolve_tiny_selector, run_synthesis, Synthesis, SynthesisInput,
};
use crate::session::subagents_synthesis_cache::{session_cache_dir, SynthesisCache};

/// Model calls in flight at once per Session, so a burst of `task()` calls cannot fan out.
const MAX_CONCURRENT_SYNTHESES: usize = 2;

type SharedCache = Arc<Mutex<SynthesisCache>>;
/// The `tiny` selector read once per Session; the inner `None` caches "no usable tiny".
type TinySelector = Arc<OnceCell<Option<String>>>;

/// Per-Session synthesis bookkeeping, held in the subagents `State`.
pub(super) struct SynthesisState {
    /// Runs the model call and the role read; a test swaps in a call-counting fake.
    exec: Arc<dyn OmpExecutor>,
    /// Loaded on first need, a `task()` call or a transcript replaying history, so a Session that does neither reads no file.
    cache: Option<SharedCache>,
    /// A `toolCallId` is handled once, so a repeated start frame cannot cost a second model call.
    started: HashSet<String>,
    /// A role change in Settings is not seen until the Session restarts, which is the price of one read per Session.
    tiny: TinySelector,
    permits: Arc<Semaphore>,
}

impl Default for SynthesisState {
    fn default() -> Self {
        Self {
            exec: Arc::new(RealOmpExecutor),
            cache: None,
            started: HashSet::new(),
            tiny: Arc::default(),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_SYNTHESES)),
        }
    }
}

/// What the detached task needs from the Session's state.
struct Runner {
    exec: Arc<dyn OmpExecutor>,
    tiny: TinySelector,
    permits: Arc<Semaphore>,
}

fn lock(cache: &SharedCache) -> MutexGuard<'_, SynthesisCache> {
    // A panic while holding the lock cannot leave the map half-written, so the data is still good.
    cache.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Labels the new `task()` call's cards from the cache, or from one background `tiny` call on a miss.
pub(super) async fn on_task_start(agent: &SessionAgent, tool_call_id: &str, args: &Value) {
    if tool_call_id.is_empty() {
        return;
    }
    let first_time = agent
        .with_subagents_state(|s| s.synthesis.started.insert(tool_call_id.to_string()))
        .await;
    if !first_time {
        return;
    }
    let Some(cache) = session_cache(agent).await else {
        log::debug!("subagent synthesis: no cache folder for this Session, skipped");
        return;
    };
    let cached = lock(&cache).get(tool_call_id).cloned();
    if let Some(synthesis) = cached {
        apply_synthesis(agent, tool_call_id, &synthesis).await;
        return;
    }
    let input = SynthesisInput {
        tool_call_id: tool_call_id.to_string(),
        context: args
            .get("context")
            .and_then(Value::as_str)
            .map(str::to_string),
        agents: read_task_specs(args)
            .iter()
            .map(|spec| {
                let task = spec.get("task").and_then(Value::as_str).unwrap_or("");
                (subagent_name_or_task(spec), task.to_string())
            })
            .collect(),
    };
    // A Session whose `tiny` was already found unusable spawns nothing at all.
    let runner = agent
        .with_subagents_state(|s| {
            let synthesis = &s.synthesis;
            (!matches!(synthesis.tiny.get(), Some(None))).then(|| Runner {
                exec: synthesis.exec.clone(),
                tiny: synthesis.tiny.clone(),
                permits: synthesis.permits.clone(),
            })
        })
        .await;
    let Some(runner) = runner else {
        log::debug!("subagent synthesis: no usable tiny role, skipped");
        return;
    };
    let agent = agent.arc();
    // Detached on purpose: the turn must not wait on a label.
    tokio::spawn(synthesise_and_apply(agent, runner, cache, input));
}

/// The Session's cache as the transcript's label source; `None` when the id is not safe as a folder name.
pub(super) async fn lookup(agent: &SessionAgent) -> Option<Arc<dyn SynthesisLookup>> {
    let cache: Arc<dyn SynthesisLookup> = session_cache(agent).await?;
    Some(cache)
}

/// Hands the cache to the Session's transcript, so replayed and live rows carry the stored labels.
pub(super) async fn attach_to_transcript(agent: &SessionAgent) {
    if let Some(lookup) = lookup(agent).await {
        agent.attach_synthesis_lookup(lookup).await;
    }
}

/// Session delete: refuses later cache writes, so a synthesis still in flight cannot recreate the folder.
pub(super) async fn discard_cache(agent: &SessionAgent) {
    let cache = agent
        .with_subagents_state(|s| s.synthesis.cache.clone())
        .await;
    if let Some(cache) = cache {
        // Waits for a write in flight, which is blocking disk work.
        let _ = tokio::task::spawn_blocking(move || lock(&cache).discard()).await;
    }
}

/// The Session's cache, loaded from disk once; `None` when the id is not safe to use as a folder name.
async fn session_cache(agent: &SessionAgent) -> Option<SharedCache> {
    if let Some(cache) = agent
        .with_subagents_state(|s| s.synthesis.cache.clone())
        .await
    {
        return Some(cache);
    }
    let dir = {
        let registry = agent.registry().lock().await;
        session_cache_dir(registry.data_dir(), agent.session_id())?
    };
    let loaded = tokio::task::spawn_blocking(move || SynthesisCache::load(&dir))
        .await
        .ok()?;
    let loaded = Arc::new(Mutex::new(loaded));
    Some(
        agent
            .with_subagents_state(|s| s.synthesis.cache.get_or_insert(loaded).clone())
            .await,
    )
}

async fn synthesise_and_apply(
    agent: Arc<SessionAgent>,
    runner: Runner,
    cache: SharedCache,
    input: SynthesisInput,
) {
    let exec = runner.exec.as_ref();
    let selector = runner
        .tiny
        .get_or_try_init(|| async {
            let roles = get_model_roles_reliable_with(exec).await?;
            Ok::<_, crate::omp::config::OmpConfigError>(resolve_tiny_selector(&roles))
        })
        .await;
    let selector = match selector {
        Ok(Some(selector)) => selector,
        Ok(None) => {
            log::debug!("subagent synthesis: no usable tiny role, skipped");
            return;
        }
        Err(err) => {
            log::warn!("subagent synthesis: could not read modelRoles: {err}");
            return;
        }
    };
    let Ok(_permit) = runner.permits.acquire().await else {
        return;
    };
    let Some(synthesis) = run_synthesis(exec, selector, &input).await else {
        return;
    };
    let (id, entry) = (input.tool_call_id, synthesis.clone());
    // Serialised under the lock, written after it is released, so a slow disk never stalls a label read.
    let inserted = lock(&cache).insert(&id, entry);
    let saved = match inserted {
        Ok(pending) => tokio::task::spawn_blocking(move || pending.write())
            .await
            .unwrap_or_else(|err| Err(io::Error::other(err))),
        Err(err) => Err(err),
    };
    if let Err(err) = saved {
        log::warn!("subagent synthesis: could not save the labels: {err}");
    }
    apply_synthesis(&agent, &id, &synthesis).await;
}

/// Sets the goal on every card of the call and each card's role by its spawn index, then emits.
async fn apply_synthesis(agent: &SessionAgent, tool_call_id: &str, synthesis: &Synthesis) {
    let summaries_value = agent
        .with_subagents_state(|s| {
            let mut changed = false;
            for entry in s
                .summaries
                .iter_mut()
                .filter(|e| e.tool_call_id == tool_call_id)
            {
                if synthesis.overall_goal.is_some() {
                    entry.overall_goal = synthesis.overall_goal.clone();
                    changed = true;
                }
                if let Some(Some(role)) = synthesis.roles.get(entry.spec_index as usize) {
                    entry.role = Some(role.clone());
                    changed = true;
                }
            }
            changed.then(|| summaries_to_value(&s.summaries))
        })
        .await;
    if let Some(value) = summaries_value {
        emit_subagents_update(agent, value).await;
    }
    // After the cache write, so a transcript row built before the synthesis landed picks the labels up.
    agent.relabel_transcript_subagents().await;
}

#[cfg(test)]
#[path = "subagents_synthesis_hook.test.rs"]
mod tests;
