// The `terminal.*` channels (contracts/terminal-ipc.md). `lib.rs` has already refused any caller that is not
// the main window; each handler here validates its own arguments. No error message carries terminal content.

use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, PoisonError};

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody, JavaScriptChannelId};
use tauri::Manager;

use super::guard::clamp_size;
use super::persist;
use super::stream::FrameSink;
use super::tab::{StateNotifier, Tab, TabInfo};
use super::{manager, CloseOutcome};
use crate::events::{self, TERMINAL_TAB_STATE};
use crate::ipc::project_session::session_working_dir;
use crate::ipc::{
    invalid_argument, required_str, AppState, Dispatcher, HandlerFuture, HandlerResult, IpcError,
};

pub fn register(d: &mut Dispatcher) {
    d.register("terminal.list", terminal_list);
    d.register("terminal.create", terminal_create);
    d.register("terminal.attach", terminal_attach);
    d.register("terminal.detach", terminal_detach);
    d.register("terminal.input", terminal_input);
    d.register("terminal.resize", terminal_resize);
    d.register("terminal.ack", terminal_ack);
    d.register("terminal.rename", terminal_rename);
    d.register("terminal.close", terminal_close);
}

fn tab_not_found() -> IpcError {
    IpcError::new("terminal-not-found", "Terminal not found")
}

fn find_tab(tab_id: &str) -> Result<Arc<Tab>, IpcError> {
    manager().find(tab_id).ok_or_else(tab_not_found)
}

/// A missing Session is `terminal-not-found` on these channels; every other error passes through.
fn session_error(err: IpcError) -> IpcError {
    if err.code == "not-found" {
        IpcError::new("terminal-not-found", err.message)
    } else {
        err
    }
}

async fn require_session(state: &AppState, session_id: &str) -> Result<(), IpcError> {
    let registry = state.registry.lock().await;
    match registry.get_session(session_id) {
        Some(_) => Ok(()),
        None => Err(IpcError::new(
            "terminal-not-found",
            format!("Session not found: {session_id}"),
        )),
    }
}

fn int_arg(args: &[Value], index: usize, name: &str) -> Result<i64, IpcError> {
    let value = args.get(index);
    value
        .and_then(Value::as_i64)
        .or_else(|| value.and_then(Value::as_f64).map(|float| float as i64))
        .ok_or_else(|| invalid_argument(format!("{name} must be a number")))
}

fn size_args(args: &[Value], index: usize) -> Result<(i64, i64), IpcError> {
    Ok((
        int_arg(args, index, "cols")?,
        int_arg(args, index + 1, "rows")?,
    ))
}

/// The `terminal:tab-state` payload; it carries the tab's identity and state, never output.
pub fn tab_state_payload(info: &TabInfo) -> Value {
    json!({ "sessionId": info.session_id, "tab": info })
}

fn notifier(state: &AppState) -> StateNotifier {
    let slot = Arc::clone(&state.app_handle);
    Arc::new(move |info: &TabInfo| {
        let handle = slot.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some(handle) = handle {
            events::emit(&handle, TERMINAL_TAB_STATE, tab_state_payload(info));
        }
    })
}

/// The renderer's `Channel`: each frame goes out as raw bytes.
struct ChannelSink(Channel<InvokeResponseBody>);

impl FrameSink for ChannelSink {
    fn send(&mut self, frame: Vec<u8>) -> bool {
        self.0.send(InvokeResponseBody::Raw(frame)).is_ok()
    }
}

fn channel_sink(state: &AppState, raw: &str) -> Result<ChannelSink, IpcError> {
    let id = JavaScriptChannelId::from_str(raw)
        .map_err(|_| invalid_argument("channel is not a Tauri channel handle"))?;
    let handle = state
        .app_handle
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let webview = handle
        .and_then(|app| app.get_webview_window("main"))
        .ok_or_else(|| IpcError::new("terminal-not-running", "The terminal window is not ready"))?;
    let target: &tauri::Webview = webview.as_ref();
    Ok(ChannelSink(
        id.channel_on::<_, InvokeResponseBody>(target.clone()),
    ))
}

fn terminal_list(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { list(&state, &args).await })
}

async fn list(state: &AppState, args: &[Value]) -> HandlerResult {
    let session_id = required_str(args, 0, "terminal.list expects a Session id")?;
    require_session(state, &session_id).await?;
    restore_saved(state, &session_id).await;
    let (tabs, active_tab_id) = manager().list(&session_id);
    Ok(json!({ "tabs": tabs, "activeTabId": active_tab_id }))
}

/// The first time a Session is used in a run, starts fresh shells for the tabs saved for it (FR-016).
async fn restore_saved(state: &AppState, session_id: &str) {
    if !manager().claim_restore(session_id) {
        return;
    }
    let known = HashSet::from([session_id.to_string()]);
    let mut saved = persist::load(&state.data_dir, &known).await;
    if let Some(record) = saved.sessions.remove(session_id) {
        let (cols, rows) = clamp_size(80, 24);
        manager().restore(session_id, &record, &notifier(state), |tab| {
            tab.start(cols, rows);
        });
    }
}

/// Saves every live Session's tab list; run after each change to it (create, rename, close).
async fn save_tabs(state: &AppState) {
    persist::save_live(&state.data_dir, || manager().saved_sessions()).await;
}

fn terminal_create(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { create(&state, &args).await })
}

async fn create(state: &AppState, args: &[Value]) -> HandlerResult {
    let session_id = required_str(args, 0, "terminal.create expects a Session id")?;
    let (cols, rows) = size_args(args, 1)?;
    let cwd = session_working_dir(state, &session_id)
        .await
        .map_err(session_error)?;
    restore_saved(state, &session_id).await;
    let (cols, rows) = clamp_size(cols, rows);
    let info = manager().create(&session_id, PathBuf::from(cwd), notifier(state), |tab| {
        tab.start(cols, rows);
    })?;
    save_tabs(state).await;
    Ok(json!(info))
}

fn terminal_attach(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { attach(&state, &args) })
}

fn attach(state: &AppState, args: &[Value]) -> HandlerResult {
    let session_id = required_str(args, 0, "terminal.attach expects a Session id")?;
    let tab_id = required_str(args, 1, "terminal.attach expects a tab id")?;
    let raw_channel = required_str(args, 2, "terminal.attach expects a channel")?;
    let (cols, rows) = size_args(args, 3)?;
    let tab = find_tab(&tab_id)?;
    if tab.session_id() != session_id {
        return Err(tab_not_found());
    }
    let sink = channel_sink(state, &raw_channel)?;
    let tab_state = tab.attach(Box::new(sink), cols, rows);
    manager().set_active(&session_id, &tab_id);
    Ok(json!({ "state": tab_state }))
}

fn terminal_detach(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let tab_id = required_str(&args, 0, "terminal.detach expects a tab id")?;
        if let Some(tab) = manager().find(&tab_id) {
            tab.detach();
        }
        Ok(Value::Null)
    })
}

fn terminal_input(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let tab_id = required_str(&args, 0, "terminal.input expects a tab id")?;
        let data = required_str(&args, 1, "terminal.input expects a string")?;
        find_tab(&tab_id)?.input(&data)?;
        Ok(Value::Null)
    })
}

// A resize or ack can race a tab that has just gone; that is not worth an error toast.
fn terminal_resize(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let tab_id = required_str(&args, 0, "terminal.resize expects a tab id")?;
        let (cols, rows) = size_args(&args, 1)?;
        if let Some(tab) = manager().find(&tab_id) {
            tab.resize(cols, rows);
        }
        Ok(Value::Null)
    })
}

fn terminal_ack(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let tab_id = required_str(&args, 0, "terminal.ack expects a tab id")?;
        let bytes = int_arg(&args, 1, "bytes")?;
        if let Some(tab) = manager().find(&tab_id) {
            tab.ack(usize::try_from(bytes).unwrap_or(0));
        }
        Ok(Value::Null)
    })
}

fn terminal_rename(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let tab_id = required_str(&args, 0, "terminal.rename expects a tab id")?;
        let name = required_str(&args, 1, "terminal.rename expects a name")?;
        let info = find_tab(&tab_id)?.rename(&name)?;
        save_tabs(&state).await;
        Ok(json!(info))
    })
}

fn terminal_close(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let tab_id = required_str(&args, 0, "terminal.close expects a tab id")?;
        let force = args
            .get(1)
            .and_then(Value::as_bool)
            .ok_or_else(|| invalid_argument("force must be true or false"))?;
        // Killing a process tree waits on Windows handles, so it runs off the async runtime's threads.
        let outcome = tokio::task::spawn_blocking(move || manager().close(&tab_id, force))
            .await
            .map_err(|_| {
                IpcError::new("terminal-not-running", "The terminal could not be closed")
            })?;
        match outcome {
            CloseOutcome::NeedsConfirm => Ok(json!({ "closed": false, "needsConfirm": true })),
            CloseOutcome::Closed => {
                save_tabs(&state).await;
                Ok(json!({ "closed": true, "needsConfirm": false }))
            }
        }
    })
}

#[cfg(test)]
#[path = "handlers.test.rs"]
mod tests;
