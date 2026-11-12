// Per-Session routing of omp host tool calls to the renderer (spec 124). Pure framing and
// planning are free functions so they test without a process.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{oneshot, Notify};

use super::approval::{self, Decision};
use super::panels::{self, INVOKE_PANEL_ACTION, LIST_PANELS, OPEN_PANEL};
use super::{sessions, sessions_send};
use super::{MAX_RESULT_BYTES, MUTATION_TIMEOUT_MS, RENDERER_TIMEOUT_MS};
use crate::omp::transcript::RequestResolution;
use crate::session::agent::SessionAgent;

pub const UNKNOWN_TOOL: &str = "unknown_tool";
pub const UNKNOWN_PANEL: &str = "unknown_panel";
pub const UNKNOWN_ACTION: &str = "unknown_action";
pub const INVALID_INPUT: &str = "invalid_input";
pub const DENIED: &str = "denied";
pub const TIMEOUT: &str = "timeout";
pub const OUTCOME_UNKNOWN: &str = "outcome_unknown";
pub const CANCELLED: &str = "cancelled";
pub const RESULT_TOO_LARGE: &str = "result_too_large";
pub const RENDERER_UNAVAILABLE: &str = "renderer_unavailable";

#[derive(Debug, Clone, PartialEq)]
pub struct ToolError {
    pub code: String,
    pub message: String,
}

impl ToolError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// A validated call, ready for approval and the renderer.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    List,
    Open {
        panel_id: String,
        input: Value,
    },
    Invoke {
        panel_id: String,
        action: String,
        input: Value,
        mutates: bool,
    },
    /// A Session tool Rust answers itself (#1858).
    Native {
        tool: String,
        args: Value,
    },
}

impl Plan {
    fn mutates(&self) -> bool {
        matches!(self, Plan::Invoke { mutates: true, .. })
    }

    /// The `args` of `agent-tools:call`.
    fn event_args(&self) -> Value {
        match self {
            Plan::List => json!({}),
            Plan::Open { panel_id, input } => json!({ "panelId": panel_id, "input": input }),
            Plan::Invoke {
                panel_id,
                action,
                input,
                ..
            } => json!({ "panelId": panel_id, "action": action, "input": input }),
            Plan::Native { args, .. } => args.clone(),
        }
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| {
        ToolError::new(
            INVALID_INPUT,
            format!("{key} is required and must be a string"),
        )
    })
}

fn input_arg(args: &Value) -> Value {
    args.get("input").cloned().unwrap_or_else(|| json!({}))
}

/// Validates a call's tool name and arguments against the embedded contract.
pub fn plan(tool: &str, args: &Value) -> Result<Plan, ToolError> {
    match tool {
        LIST_PANELS => {
            panels::validate(&panels::tool_parameters(tool), args, "arguments")
                .map_err(|m| ToolError::new(INVALID_INPUT, m))?;
            Ok(Plan::List)
        }
        OPEN_PANEL => {
            panels::validate_keys(args, &["panelId", "input"])
                .map_err(|m| ToolError::new(INVALID_INPUT, m))?;
            let panel_id = str_arg(args, "panelId")?;
            let panel = panels::panel(panel_id).ok_or_else(|| unknown_panel(panel_id))?;
            let input = input_arg(args);
            match &panel.open_input_schema {
                Some(schema) => panels::validate(schema, &input, "input"),
                None if input.as_object().is_some_and(|o| o.is_empty()) => Ok(()),
                None => Err(format!("{panel_id} takes no open input")),
            }
            .map_err(|m| ToolError::new(INVALID_INPUT, m))?;
            Ok(Plan::Open {
                panel_id: panel_id.to_string(),
                input,
            })
        }
        INVOKE_PANEL_ACTION => {
            panels::validate_keys(args, &["panelId", "action", "input"])
                .map_err(|m| ToolError::new(INVALID_INPUT, m))?;
            let panel_id = str_arg(args, "panelId")?;
            let name = str_arg(args, "action")?;
            panels::panel(panel_id).ok_or_else(|| unknown_panel(panel_id))?;
            let action = panels::action(panel_id, name).ok_or_else(|| {
                ToolError::new(UNKNOWN_ACTION, format!("{panel_id} has no action {name}"))
            })?;
            let input = input_arg(args);
            panels::validate(&action.input_schema, &input, "input")
                .map_err(|m| ToolError::new(INVALID_INPUT, m))?;
            Ok(Plan::Invoke {
                panel_id: panel_id.to_string(),
                action: name.to_string(),
                input,
                mutates: action.mutates,
            })
        }
        other if sessions::is_session_tool(other) => {
            sessions::check_args(other, args)?;
            Ok(Plan::Native {
                tool: other.to_string(),
                args: args.clone(),
            })
        }
        other => Err(ToolError::new(
            UNKNOWN_TOOL,
            format!("{other} is not a Refract tool"),
        )),
    }
}

fn unknown_panel(id: &str) -> ToolError {
    ToolError::new(UNKNOWN_PANEL, format!("{id} is not a Refract panel"))
}

/// Success frame; a value over the cap becomes `result_too_large` rather than being cut.
pub fn ok_frame(id: &str, value: &Value) -> Value {
    let text = value.to_string();
    if text.len() > MAX_RESULT_BYTES {
        return error_frame(
            id,
            &ToolError::new(
                RESULT_TOO_LARGE,
                format!(
                    "the result is {} bytes; the limit is {MAX_RESULT_BYTES}",
                    text.len()
                ),
            ),
        );
    }
    json!({
        "type": "host_tool_result",
        "id": id,
        "result": { "content": [{ "type": "text", "text": text }] }
    })
}

pub fn error_frame(id: &str, err: &ToolError) -> Value {
    let text = json!({ "error": { "code": err.code, "message": err.message } }).to_string();
    json!({
        "type": "host_tool_result",
        "id": id,
        "result": { "content": [{ "type": "text", "text": text }], "isError": true },
        "isError": true
    })
}

/// The renderer's `{ ok, value | error }` reply as a result.
pub fn parse_reply(reply: &Value) -> Result<Value, ToolError> {
    match reply.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(reply.get("value").cloned().unwrap_or(Value::Null)),
        Some(false) => {
            let error = reply.get("error");
            let code = error
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .unwrap_or(INVALID_INPUT);
            let message = error
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("the panel reported an error");
            Err(ToolError::new(code, message))
        }
        None => Err(ToolError::new(
            INVALID_INPUT,
            "the renderer reply has no ok flag",
        )),
    }
}

struct Call {
    id: String,
    tool: String,
    args: Value,
}

fn parse_call(frame: &Value) -> Option<Call> {
    Some(Call {
        id: frame.get("id")?.as_str()?.to_string(),
        tool: frame.get("toolName")?.as_str()?.to_string(),
        args: frame.get("arguments").cloned().unwrap_or_else(|| json!({})),
    })
}

enum Reply {
    Renderer(Result<Value, ToolError>),
    Approval(Decision),
}

#[derive(Default)]
struct Inner {
    cancels: HashMap<String, Arc<Notify>>,
    waits: HashMap<String, oneshot::Sender<Reply>>,
    starts: HashMap<String, oneshot::Sender<()>>,
}

/// One per Session. Dropping a sender while a call awaits it reads as `cancelled`.
#[derive(Default)]
pub struct ToolRouter {
    inner: StdMutex<Inner>,
}

impl ToolRouter {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("tool router mutex poisoned")
    }

    /// `None` when the id is already pending, so the live call's entry is never overwritten.
    fn begin(&self, call_id: &str) -> Option<Arc<Notify>> {
        let mut inner = self.lock();
        if inner.cancels.contains_key(call_id) {
            return None;
        }
        let cancel = Arc::new(Notify::new());
        inner.cancels.insert(call_id.to_string(), cancel.clone());
        Some(cancel)
    }

    fn forget(&self, key: &str) {
        self.lock().waits.remove(key);
    }

    fn wait_for(&self, key: &str) -> oneshot::Receiver<Reply> {
        let (tx, rx) = oneshot::channel();
        self.lock().waits.insert(key.to_string(), tx);
        rx
    }

    fn wait_started(&self, call_id: &str) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        self.lock().starts.insert(call_id.to_string(), tx);
        rx
    }

    fn forget_start(&self, call_id: &str) {
        self.lock().starts.remove(call_id);
    }

    fn finish(&self, call_id: &str) {
        let mut inner = self.lock();
        inner.cancels.remove(call_id);
        inner.waits.remove(call_id);
        inner.starts.remove(call_id);
        inner.waits.remove(&approval::request_id(call_id));
    }

    /// Serves `host_tool_call` on its own task, so the frame loop never waits on the renderer.
    pub fn handle_call(&self, agent: &Arc<SessionAgent>, frame: &Value) {
        let Some(call) = parse_call(frame) else {
            return;
        };
        // Registered before the spawn so a cancel arriving right behind the call is not lost.
        let cancel = self.begin(&call.id);
        let agent = agent.clone();
        tokio::spawn(async move {
            let Some(cancel) = cancel else {
                let err = ToolError::new(INVALID_INPUT, "a call with this id is already pending");
                if let Some(proc) = agent.tool_process().await {
                    let _ = proc.send_raw(error_frame(&call.id, &err)).await;
                }
                return;
            };
            serve(agent, call, cancel).await
        });
    }

    /// `host_tool_cancel`: omp abandoned the call; no result is sent.
    pub fn handle_cancel(&self, frame: &Value) {
        let Some(target) = frame.get("targetId").and_then(Value::as_str) else {
            return;
        };
        if let Some(cancel) = self.lock().cancels.get(target) {
            cancel.notify_one();
        }
    }

    /// The renderer's answer; the first one wins and later ones are dropped.
    pub fn answer(&self, call_id: &str, reply: &Value) -> bool {
        let Some(tx) = self.lock().waits.remove(call_id) else {
            return false;
        };
        tx.send(Reply::Renderer(parse_reply(reply))).is_ok()
    }

    /// The developer's answer on a Refract-owned approval card.
    pub fn answer_approval(&self, request_id: &str, decision: Decision) -> bool {
        let Some(tx) = self.lock().waits.remove(request_id) else {
            return false;
        };
        tx.send(Reply::Approval(decision)).is_ok()
    }

    /// The renderer is about to change files. False means Rust already gave up on the call (or it
    /// is not a pending mutation), so the renderer must change nothing.
    pub fn started(&self, call_id: &str) -> bool {
        // Sending under the lock serialises this with `forget_start`, so a value is either in
        // the channel before the deadline path looks, or the sender is gone and this refuses.
        let mut inner = self.lock();
        inner
            .starts
            .remove(call_id)
            .is_some_and(|tx| tx.send(()).is_ok())
    }

    /// Process exit or Session stop: cancels every call and frees every wait.
    pub fn drop_all(&self) {
        let mut inner = self.lock();
        inner.waits.clear();
        inner.starts.clear();
        for cancel in inner.cancels.values() {
            cancel.notify_one();
        }
        inner.cancels.clear();
    }
}

async fn serve(agent: Arc<SessionAgent>, call: Call, cancel: Arc<Notify>) {
    let router = agent.tool_router();
    let outcome = tokio::select! {
        result = run(&agent, &call) => Some(result),
        _ = cancel.notified() => None,
    };
    router.finish(&call.id);
    let Some(outcome) = outcome else {
        agent
            .tool_resolve_approval(
                &approval::request_id(&call.id),
                RequestResolution::Cancelled,
            )
            .await;
        return;
    };
    let frame = match &outcome {
        Ok(value) => ok_frame(&call.id, value),
        Err(err) => error_frame(&call.id, err),
    };
    if let Some(proc) = agent.tool_process().await {
        let _ = proc.send_raw(frame).await;
    }
}

async fn run(agent: &Arc<SessionAgent>, call: &Call) -> Result<Value, ToolError> {
    let plan = plan(&call.tool, &call.args)?;
    if let Plan::Native { tool, args } = &plan {
        return run_native(agent, tool, args).await;
    }
    if approval::needs_approval(plan.mutates(), agent.tool_is_yolo().await) {
        ask_developer(agent, call, &plan).await?;
    }
    ask_renderer(agent, call, &plan).await
}

/// Session tools Rust answers itself: no renderer round trip and no approval card.
async fn run_native(agent: &SessionAgent, tool: &str, args: &Value) -> Result<Value, ToolError> {
    match tool {
        sessions::LIST_SESSIONS => sessions::list(agent, args).await,
        sessions::GET_SESSION_STATUS => sessions::get_status(agent, args).await,
        _ => sessions_send::send(agent, args).await,
    }
}

async fn ask_developer(
    agent: &Arc<SessionAgent>,
    call: &Call,
    plan: &Plan,
) -> Result<(), ToolError> {
    let Plan::Invoke {
        panel_id,
        action,
        input,
        ..
    } = plan
    else {
        return Ok(());
    };
    let key = approval::request_id(&call.id);
    let rx = agent.tool_router().wait_for(&key);
    agent
        .tool_raise_approval(approval::card(&call.id, panel_id, action, input))
        .await;
    approval_outcome(rx.await.ok())
}

fn approval_outcome(reply: Option<Reply>) -> Result<(), ToolError> {
    match reply {
        Some(Reply::Approval(Decision::Approved)) => Ok(()),
        Some(Reply::Approval(Decision::Denied)) => {
            Err(ToolError::new(DENIED, "the developer denied this action"))
        }
        _ => Err(ToolError::new(CANCELLED, "the approval was cancelled")),
    }
}

async fn ask_renderer(
    agent: &Arc<SessionAgent>,
    call: &Call,
    plan: &Plan,
) -> Result<Value, ToolError> {
    let router = agent.tool_router();
    let rx = router.wait_for(&call.id);
    let started = plan.mutates().then(|| router.wait_started(&call.id));
    if !agent.tool_events().emit_agent_tools_call(
        agent.tool_session_id(),
        &call.id,
        &call.tool,
        &plan.event_args(),
    ) {
        router.forget(&call.id);
        router.forget_start(&call.id);
        return Err(ToolError::new(
            RENDERER_UNAVAILABLE,
            "Refract has no window to show this panel in",
        ));
    }
    match started {
        Some(started) => wait_mutation(router, &call.id, started, rx).await,
        None => wait_renderer(rx).await,
    }
}

fn renderer_result(reply: Result<Reply, oneshot::error::RecvError>) -> Result<Value, ToolError> {
    match reply {
        Ok(Reply::Renderer(result)) => result,
        _ => Err(ToolError::new(CANCELLED, "the call was cancelled")),
    }
}

/// A read or navigation action: one window from emit to the renderer's reply.
async fn wait_renderer(rx: oneshot::Receiver<Reply>) -> Result<Value, ToolError> {
    match tokio::time::timeout(Duration::from_millis(RENDERER_TIMEOUT_MS), rx).await {
        Ok(reply) => renderer_result(reply),
        Err(_) => Err(ToolError::new(
            TIMEOUT,
            format!(
                "the panel did not answer within {} seconds",
                RENDERER_TIMEOUT_MS / 1000
            ),
        )),
    }
}

enum Early {
    Reply(Result<Reply, oneshot::error::RecvError>),
    Started(Result<(), oneshot::error::RecvError>),
    Silent,
}

/// A file-changing action. Before `started` a silence is `timeout` (nothing changed, a retry is
/// safe); after it, a silence is `outcome_unknown`, because the files may already have changed.
async fn wait_mutation(
    router: &ToolRouter,
    call_id: &str,
    started: oneshot::Receiver<()>,
    reply: oneshot::Receiver<Reply>,
) -> Result<Value, ToolError> {
    let window = Duration::from_millis(MUTATION_TIMEOUT_MS);
    wait_mutation_within(window, router, call_id, started, reply).await
}

/// Split out so the race test can use a window of a few milliseconds on a real clock.
async fn wait_mutation_within(
    window: Duration,
    router: &ToolRouter,
    call_id: &str,
    mut started: oneshot::Receiver<()>,
    mut reply: oneshot::Receiver<Reply>,
) -> Result<Value, ToolError> {
    let early = tokio::select! {
        biased;
        r = &mut reply => Early::Reply(r),
        s = &mut started => Early::Started(s),
        _ = tokio::time::sleep(window) => Early::Silent,
    };
    match early {
        Early::Reply(reply) => return renderer_result(reply),
        Early::Started(Ok(())) => {}
        Early::Started(Err(_)) => return Err(ToolError::new(CANCELLED, "the call was cancelled")),
        Early::Silent => {
            // `started` sends while holding the router's lock, so once `forget_start` returns
            // either its value is already in the channel or it will be refused.
            router.forget_start(call_id);
            if started.try_recv().is_err() {
                return Err(ToolError::new(
                    TIMEOUT,
                    format!(
                        "the panel did not start the action within {} seconds; nothing changed, so a retry is safe",
                        MUTATION_TIMEOUT_MS / 1000
                    ),
                ));
            }
        }
    }
    match tokio::time::timeout(window, reply).await {
        Ok(reply) => renderer_result(reply),
        Err(_) => Err(ToolError::new(
            OUTCOME_UNKNOWN,
            "the action started and its outcome is unknown, so check the panel before you retry",
        )),
    }
}

#[cfg(test)]
#[path = "router.test.rs"]
mod tests;
