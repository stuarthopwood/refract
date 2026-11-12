// Pause handlers only validate arguments; the per-Session logic lives in `session::agent::pause`.

use serde_json::{json, Value};

use crate::session::SessionStatus;

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("chat.pause", chat_pause);
    d.register("chat.resume", chat_resume);
    d.register("chat.pauseAll", chat_pause_all);
    d.register("chat.resumeAll", chat_resume_all);
}

fn map_error(err: crate::session::AgentError) -> IpcError {
    IpcError::new(err.code, err.message)
}

async fn session_agent(
    state: &AppState,
    args: &[Value],
    name: &str,
) -> Result<std::sync::Arc<crate::session::SessionAgent>, IpcError> {
    let Some(session_id) = args.first().and_then(Value::as_str) else {
        return Err(invalid_argument(format!(
            "{name} expects a string sessionId"
        )));
    };
    if state
        .registry
        .lock()
        .await
        .get_session(session_id)
        .is_none()
    {
        return Err(not_found(format!("Session not found: {session_id}")));
    }
    Ok(state.session_manager.get_or_create_agent(session_id))
}

pub fn chat_pause(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let agent = session_agent(&state, &args, "chat.pause").await?;
        agent.pause().await.map_err(map_error)
    })
}

pub fn chat_resume(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let agent = session_agent(&state, &args, "chat.resume").await?;
        agent.resume().await.map_err(map_error)
    })
}

/// Pauses every live Session (one with a running agent process or a turn in flight).
pub fn chat_pause_all(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let mut paused = 0;
        for agent in state.session_manager.live_agents() {
            if agent.status().await == SessionStatus::Stopped {
                continue;
            }
            if agent.pause().await.is_ok() {
                paused += 1;
            }
        }
        Ok(json!({ "count": paused }))
    })
}

/// Resumes every paused Session, starting stopped ones. A Session that fails to start stays paused
/// with its held messages and is counted in `failed`; the rest still resume. Archived Sessions are left alone.
pub fn chat_resume_all(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let ids: Vec<String> = state
            .registry
            .lock()
            .await
            .snapshot()
            .sessions
            .into_iter()
            .filter(|s| s.paused_held.is_some() && s.archived_at.is_none())
            .map(|s| s.id)
            .collect();
        let mut resumed = 0;
        let mut failed = 0;
        for id in ids {
            match state
                .session_manager
                .get_or_create_agent(&id)
                .resume()
                .await
            {
                Ok(_) => resumed += 1,
                Err(_) => failed += 1,
            }
        }
        Ok(json!({ "count": resumed, "failed": failed }))
    })
}
