// IPC handlers for `githubStack.state` and `githubStack.install` (#1867): the gh-stack extension's
// readiness, probed and installed through the `gh` Refract resolves.
use serde_json::Value;

use crate::github::gh_stack_state::{self, runtime};

use super::{AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("githubStack.state", github_stack_state);
    d.register("githubStack.install", github_stack_install);
}

fn github_stack_state(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let state = gh_stack_state::state(runtime())
            .await
            .map_err(|err| IpcError::new(err.code.as_str(), err.message))?;
        Ok(serde_json::to_value(state).expect("GhStackState is always JSON-serialisable"))
    })
}

fn github_stack_install(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let state = gh_stack_state::install(runtime())
            .await
            .map_err(|err| IpcError::new(err.code.as_str(), err.message))?;
        Ok(serde_json::to_value(state).expect("GhStackState is always JSON-serialisable"))
    })
}
