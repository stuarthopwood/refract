// `sessions.setHidden` (issue #748): the Session list's hide flag. A view setting, not a
// lifecycle state -- it never touches the agent, the file watcher or the worktree, and it is
// independent of `archivedAt` (a Session can be hidden, archived, or both).

use serde_json::Value;

use crate::store::registry::SessionPatch;

use super::{
    arg_str, invalid_argument, map_registry_error, not_found, now_iso8601, AppState, Dispatcher,
    HandlerFuture,
};

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.setHidden", sessions_set_hidden);
}

pub fn sessions_set_hidden(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.setHidden expects (id: string, hidden: boolean)",
                ))
            }
        };
        let hidden = match args.get(1).and_then(Value::as_bool) {
            Some(hidden) => hidden,
            None => {
                return Err(invalid_argument(
                    "sessions.setHidden expects (id: string, hidden: boolean)",
                ))
            }
        };
        let mut registry = state.registry.lock().await;
        let already_hidden = registry
            .get_session(&id)
            .ok_or_else(|| not_found(format!("Session not found: {id}")))?
            .hidden_at
            .is_some();
        if already_hidden == hidden {
            return Ok(Value::Null);
        }
        registry
            .update_session(
                &id,
                SessionPatch {
                    hidden_at: Some(hidden.then(now_iso8601)),
                    ..Default::default()
                },
            )
            .await
            .map_err(map_registry_error)?;
        drop(registry);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}
