// `agents.snapshot`: the Agents panel's pull for a renderer that subscribed after the last
// `agents:update` push, which is deduped and so never repeats an unchanged aggregate.

use serde_json::{json, Value};

use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("agents.snapshot", agents_snapshot);
}

pub fn agents_snapshot(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let groups = state.session_manager.agents_snapshot().await;
        Ok(json!({ "groups": groups }))
    })
}

#[cfg(test)]
#[path = "agents.test.rs"]
mod tests;
