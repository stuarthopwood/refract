// Runs the `tiny` calls that label the Subagents cards: one group synthesis per live `task()` call
// and, unless Summarise agent cards is off, one start and one finish card summary per agent.
// History replay never reaches `handle_task_start`, so a replayed card is labelled from the cache or not at all.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;
use tokio::sync::{OnceCell, Semaphore};

use super::{
    emit_subagents_update, read_task_specs, subagent_name_or_task, summaries_to_value,
    SummaryStatus,
};
use crate::ipc::model_roles::get_model_roles_reliable_with;
use crate::omp::config::{OmpExecutor, RealOmpExecutor};
use crate::omp::transcript::synthesis_labels::SynthesisLookup;
use crate::session::agent::SessionAgent;
use crate::session::subagents_synthesis::{
    resolve_tiny_selector, run_card_summary, run_synthesis, CardSummaryInput, Synthesis,
    SynthesisInput,
};
use crate::session::subagents_synthesis_cache::{session_cache_dir, PendingWrite, SynthesisCache};

/// `message_end` frames a settled agent may pass with no result text before its finish summary is given up.
const MAX_RESULT_MISSES: u8 = 2;

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
    /// The brief of each agent still waiting for its finish summary, keyed by `(toolCallId, specIndex)`;
    /// taking it is what claims the one finish call.
    briefs: HashMap<(String, u32), Brief>,
    /// A role change in Settings is not seen until the Session restarts, which is the price of one read per Session.
    tiny: TinySelector,
    permits: Arc<Semaphore>,
    /// Set when the Session is deleted, even if its cache was never loaded: nothing loads, spawns or writes after.
    discarded: bool,
}

impl Default for SynthesisState {
    fn default() -> Self {
        Self {
            exec: Arc::new(RealOmpExecutor),
            cache: None,
            started: HashSet::new(),
            briefs: HashMap::new(),
            tiny: Arc::default(),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_SYNTHESES)),
            discarded: false,
        }
    }
}

/// What the detached task needs from the Session's state.
struct Runner {
    exec: Arc<dyn OmpExecutor>,
    tiny: TinySelector,
    permits: Arc<Semaphore>,
}

/// One agent's name and brief as `task()` was called with them.
#[derive(Clone)]
struct Brief {
    name: String,
    task: String,
    /// `message_end` frames that found the agent settled with no result text yet.
    result_misses: u8,
}

/// One card summary call: the start call has no `result`, the finish call has one.
struct CardJob {
    tool_call_id: String,
    spec_index: u32,
    brief: Brief,
    result: Option<String>,
}

fn lock(cache: &SharedCache) -> MutexGuard<'_, SynthesisCache> {
    // A panic while holding the lock cannot leave the map half-written, so the data is still good.
    cache.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Labels the new `task()` call's cards from the cache, or from background `tiny` calls on a miss.
pub(super) async fn on_task_start(agent: &SessionAgent, tool_call_id: &str, args: &Value) {
    if tool_call_id.is_empty() {
        return;
    }
    let specs = read_task_specs(args);
    let briefs: Vec<Brief> = specs
        .iter()
        .map(|spec| Brief {
            name: subagent_name_or_task(spec),
            task: spec
                .get("task")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            result_misses: 0,
        })
        .collect();
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
    if agent.summarise_agent_cards_enabled().await {
        // Kept only while a finish call can happen, so `on_settled` never scans for an agent it cannot summarise.
        agent
            .with_subagents_state(|s| {
                for (index, brief) in briefs.iter().enumerate() {
                    s.synthesis
                        .briefs
                        .insert((tool_call_id.to_string(), index as u32), brief.clone());
                }
            })
            .await;
        for (index, brief) in briefs.iter().enumerate() {
            start_card_summary(agent, &cache, tool_call_id, index as u32, brief).await;
        }
    }
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
        agents: briefs
            .iter()
            .map(|brief| (brief.name.clone(), brief.task.clone()))
            .collect(),
    };
    let Some(runner) = runner(agent).await else {
        log::debug!("subagent synthesis: no usable tiny role, skipped");
        return;
    };
    let agent = agent.arc();
    // Detached on purpose: the turn must not wait on a label.
    tokio::spawn(synthesise_and_apply(agent, runner, cache, input));
}

/// Settles the Subagents card summaries: each agent whose result has arrived since the last call is
/// summarised from its brief and its result.
pub(super) async fn on_settled(agent: &SessionAgent, frame_type: &str) {
    let due: Vec<(String, u32, SummaryStatus)> = agent
        .with_subagents_state(|s| {
            s.summaries
                .iter()
                .filter(|e| !matches!(e.status, SummaryStatus::Running))
                .filter(|e| {
                    s.synthesis
                        .briefs
                        .contains_key(&(e.tool_call_id.clone(), e.spec_index))
                })
                .map(|e| (e.tool_call_id.clone(), e.spec_index, e.status))
                .collect()
        })
        .await;
    if due.is_empty() || !agent.summarise_agent_cards_enabled().await {
        return;
    }
    let Some(cache) = session_cache(agent).await else {
        return;
    };
    for (tool_call_id, spec_index, status) in due {
        let result = agent
            .subagent_result_text(&tool_call_id, spec_index)
            .await
            .filter(|text| !text.trim().is_empty());
        let Some(result) = result else {
            note_missing_result(agent, (tool_call_id, spec_index), status, frame_type).await;
            continue;
        };
        let claimed = agent
            .with_subagents_state(|s| {
                s.synthesis
                    .briefs
                    .remove(&(tool_call_id.clone(), spec_index))
            })
            .await;
        let Some(brief) = claimed else {
            continue;
        };
        let cached = lock(&cache)
            .card_summaries(&tool_call_id, spec_index)
            .and_then(|cards| cards.finish.clone());
        if cached.is_some() {
            apply_card_summary(agent, &cache, &tool_call_id, spec_index).await;
            continue;
        }
        let job = CardJob {
            tool_call_id,
            spec_index,
            brief,
            result: Some(result),
        };
        spawn_card_summary(agent, &cache, job).await;
    }
}

/// A settled agent whose result text is not there yet. A stopped or exited agent never gets one, and a
/// background agent's arrives on `message_end`, so the brief goes after a second `message_end` that
/// still finds none; until then it stays and a later frame can trigger the call.
async fn note_missing_result(
    agent: &SessionAgent,
    key: (String, u32),
    status: SummaryStatus,
    frame_type: &str,
) {
    let no_result_will_come = matches!(status, SummaryStatus::Cancelled | SummaryStatus::Exited);
    agent
        .with_subagents_state(|s| {
            let Some(brief) = s.synthesis.briefs.get_mut(&key) else {
                return;
            };
            if frame_type == "message_end" {
                brief.result_misses += 1;
            }
            if no_result_will_come || brief.result_misses >= MAX_RESULT_MISSES {
                s.synthesis.briefs.remove(&key);
            }
        })
        .await;
}

/// The start summary of one agent, from the cache when it is there, else from one background call.
async fn start_card_summary(
    agent: &SessionAgent,
    cache: &SharedCache,
    tool_call_id: &str,
    spec_index: u32,
    brief: &Brief,
) {
    let cached = lock(cache)
        .card_summaries(tool_call_id, spec_index)
        .and_then(|cards| cards.best().map(str::to_string));
    if cached.is_some() {
        apply_card_summary(agent, cache, tool_call_id, spec_index).await;
        return;
    }
    let job = CardJob {
        tool_call_id: tool_call_id.to_string(),
        spec_index,
        brief: brief.clone(),
        result: None,
    };
    spawn_card_summary(agent, cache, job).await;
}

async fn spawn_card_summary(agent: &SessionAgent, cache: &SharedCache, job: CardJob) {
    let Some(runner) = runner(agent).await else {
        log::debug!("subagent card summary: no usable tiny role, skipped");
        return;
    };
    // Detached on purpose: the turn must not wait on a summary.
    tokio::spawn(summarise_and_apply(agent.arc(), runner, cache.clone(), job));
}

/// What a detached call needs, or `None` once the Session's `tiny` was found unusable, so it spawns nothing.
async fn runner(agent: &SessionAgent) -> Option<Runner> {
    agent
        .with_subagents_state(|s| {
            let synthesis = &s.synthesis;
            (!matches!(synthesis.tiny.get(), Some(None))).then(|| Runner {
                exec: synthesis.exec.clone(),
                tiny: synthesis.tiny.clone(),
                permits: synthesis.permits.clone(),
            })
        })
        .await
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

/// Session delete: refuses later cache loads and writes, so a `task()` start or a synthesis still in
/// flight cannot recreate the folder.
pub(super) async fn discard_cache(agent: &SessionAgent) {
    let cache = agent
        .with_subagents_state(|s| {
            s.synthesis.discarded = true;
            s.synthesis.cache.clone()
        })
        .await;
    if let Some(cache) = cache {
        // Cloned out of the cache lock first: waiting for a write in flight is blocking disk work.
        let discarder = lock(&cache).discarder();
        let _ = tokio::task::spawn_blocking(move || discarder.discard()).await;
    }
}

/// The Session's cache, loaded from disk once; `None` when the id is not safe to use as a folder name
/// or the Session was deleted.
async fn session_cache(agent: &SessionAgent) -> Option<SharedCache> {
    let (discarded, loaded_already) = agent
        .with_subagents_state(|s| (s.synthesis.discarded, s.synthesis.cache.clone()))
        .await;
    if discarded {
        return None;
    }
    if loaded_already.is_some() {
        return loaded_already;
    }
    let dir = {
        let registry = agent.registry().lock().await;
        session_cache_dir(registry.data_dir(), agent.session_id())?
    };
    let loaded = tokio::task::spawn_blocking(move || SynthesisCache::load(&dir))
        .await
        .ok()?;
    let loaded = Arc::new(Mutex::new(loaded));
    // Re-checked under the state lock, because a delete may have landed while the file was loading.
    agent
        .with_subagents_state(|s| {
            (!s.synthesis.discarded).then(|| s.synthesis.cache.get_or_insert(loaded).clone())
        })
        .await
}

/// The Session's `tiny` selector, read once; `None` when it is unset or unreadable.
async fn tiny_selector(runner: &Runner) -> Option<&str> {
    let exec = runner.exec.as_ref();
    let selector = runner
        .tiny
        .get_or_try_init(|| async {
            let roles = get_model_roles_reliable_with(exec).await?;
            Ok::<_, crate::omp::config::OmpConfigError>(resolve_tiny_selector(&roles))
        })
        .await;
    match selector {
        Ok(Some(selector)) => Some(selector.as_str()),
        Ok(None) => {
            log::debug!("subagent synthesis: no usable tiny role, skipped");
            None
        }
        Err(err) => {
            log::warn!("subagent synthesis: could not read modelRoles: {err}");
            None
        }
    }
}

/// Serialised under the cache lock, written after it is released, so a slow disk never stalls a label read.
async fn write_pending(pending: io::Result<PendingWrite>) {
    let saved = match pending {
        Ok(pending) => tokio::task::spawn_blocking(move || pending.write())
            .await
            .unwrap_or_else(|err| Err(io::Error::other(err))),
        Err(err) => Err(err),
    };
    if let Err(err) = saved {
        log::warn!("subagent synthesis: could not save the labels: {err}");
    }
}

async fn synthesise_and_apply(
    agent: Arc<SessionAgent>,
    runner: Runner,
    cache: SharedCache,
    input: SynthesisInput,
) {
    let Some(selector) = tiny_selector(&runner).await else {
        return;
    };
    let Ok(_permit) = runner.permits.acquire().await else {
        return;
    };
    let Some(synthesis) = run_synthesis(runner.exec.as_ref(), selector, &input).await else {
        return;
    };
    let (id, entry) = (input.tool_call_id, synthesis.clone());
    let pending = lock(&cache).insert(&id, entry);
    write_pending(pending).await;
    apply_synthesis(&agent, &id, &synthesis).await;
}

/// One start or finish call; a failed call stores and emits nothing, so the card keeps what it had.
async fn summarise_and_apply(
    agent: Arc<SessionAgent>,
    runner: Runner,
    cache: SharedCache,
    job: CardJob,
) {
    let Some(selector) = tiny_selector(&runner).await else {
        return;
    };
    let Ok(_permit) = runner.permits.acquire().await else {
        return;
    };
    let input = CardSummaryInput {
        name: &job.brief.name,
        task: &job.brief.task,
        result: job.result.as_deref(),
    };
    let Some(text) = run_card_summary(runner.exec.as_ref(), selector, &input).await else {
        return;
    };
    let pending = lock(&cache).set_card_summary(
        &job.tool_call_id,
        job.spec_index,
        job.result.is_some(),
        text,
    );
    write_pending(pending).await;
    apply_card_summary(&agent, &cache, &job.tool_call_id, job.spec_index).await;
}

/// Puts the best stored summary of one agent on its card, so a late start result never replaces a finish one.
async fn apply_card_summary(
    agent: &SessionAgent,
    cache: &SharedCache,
    tool_call_id: &str,
    spec_index: u32,
) {
    let Some(text) = lock(cache)
        .card_summaries(tool_call_id, spec_index)
        .and_then(|cards| cards.best().map(str::to_string))
    else {
        return;
    };
    let summaries_value = agent
        .with_subagents_state(|s| {
            let entry = s
                .summaries
                .iter_mut()
                .find(|e| e.tool_call_id == tool_call_id && e.spec_index == spec_index)?;
            if entry.card_summary.as_deref() == Some(text.as_str()) {
                return None;
            }
            entry.card_summary = Some(text);
            Some(summaries_to_value(&s.summaries))
        })
        .await;
    if let Some(value) = summaries_value {
        emit_subagents_update(agent, value).await;
    }
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
