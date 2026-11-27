// Conversation tree commands (#696): view, label, Rewind and Fork. Rewind and Fork run only while `idle`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::omp::process::OmpProcess;
use crate::omp::transcript::TranscriptState;
use crate::store::registry::SessionPatch;

use super::launch_support::fetch_all_messages;
use super::tree_projection::{project_tree, rpc_failure};
use super::{AgentError, SessionAgent, SessionStatus, DEFAULT_REQUEST_TIMEOUT_MS};

/// A branch summary runs the session's model, so it outlives an ordinary request.
const SUMMARIZE_TIMEOUT_MS: u64 = 300_000;

/// What a Rewind did. `cancelled` is a summary the developer stopped; nothing moved then.
pub struct RewindOutcome {
    pub cancelled: bool,
    pub editor_text: Option<String>,
}

fn tree_failed(detail: impl std::fmt::Display) -> AgentError {
    AgentError::new("tree-failed", detail.to_string())
}

/// `Ok(data)` for a `success: true` frame; otherwise the mapped failure.
fn data_of(res: &Value) -> Result<&Value, AgentError> {
    if res.get("success").and_then(Value::as_bool) == Some(true) {
        Ok(res.get("data").unwrap_or(&Value::Null))
    } else {
        Err(rpc_failure(res))
    }
}

impl SessionAgent {
    /// The live process for a tree command. `require_idle` refuses with `not-idle` while a turn or other work runs.
    async fn tree_process(
        &self,
        action: &str,
        require_idle: bool,
    ) -> Result<Arc<OmpProcess>, AgentError> {
        let mut state = self.state.lock().await;
        let Some(proc) = state.process.clone() else {
            return Err(AgentError::new(
                "agent-not-running",
                format!(
                    "SessionAgent {}: cannot {action} without a running agent",
                    self.session_id
                ),
            ));
        };
        if require_idle {
            if state.status != SessionStatus::Idle {
                return Err(AgentError::new(
                    "not-idle",
                    format!(
                        "SessionAgent {}: cannot {action} while {:?}",
                        self.session_id, state.status
                    ),
                ));
            }
            // Bump so a late settle-time reply is already stale (#856).
            state.turn_generation = state.turn_generation.wrapping_add(2);
        }
        Ok(proc)
    }

    async fn tree_request(
        &self,
        proc: &OmpProcess,
        cmd: Value,
        timeout_ms: u64,
    ) -> Result<Value, AgentError> {
        proc.request(cmd, timeout_ms).await.map_err(tree_failed)
    }

    /// The current Conversation's message entries with their labels. Works while a turn runs.
    pub async fn conversation_tree(&self) -> Result<Value, AgentError> {
        let proc = self
            .tree_process("read the Conversation tree", false)
            .await?;
        let res = self
            .tree_request(
                &proc,
                json!({ "type": "get_tree" }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await?;
        Ok(project_tree(data_of(&res)?))
    }

    /// An empty `label` clears it. Allowed while a turn runs: OMP appends the label into the in-flight chain.
    pub async fn set_entry_label(&self, entry_id: &str, label: &str) -> Result<(), AgentError> {
        let proc = self.tree_process("label an entry", false).await?;
        let mut cmd = json!({ "type": "set_label", "entryId": entry_id });
        if !label.trim().is_empty() {
            cmd["label"] = Value::String(label.trim().to_string());
        }
        let res = self
            .tree_request(&proc, cmd, DEFAULT_REQUEST_TIMEOUT_MS)
            .await?;
        data_of(&res).map(|_| ())
    }

    /// Stops a branch summary a Rewind started. A no-op when none is running.
    pub async fn abort_branch_summary(&self) -> Result<(), AgentError> {
        let proc = self.tree_process("cancel a summary", false).await?;
        let res = self
            .tree_request(
                &proc,
                json!({ "type": "abort_branch_summary" }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await?;
        data_of(&res).map(|_| ())
    }

    /// Moves the leaf to `entry_id` in the same Conversation (`navigate_tree`), then rebuilds the transcript.
    /// OMP keeps a rewind in memory only; the next prompt persists it.
    pub async fn rewind_conversation(
        &self,
        entry_id: &str,
        summarize: bool,
    ) -> Result<RewindOutcome, AgentError> {
        let proc = self.tree_process("rewind", true).await?;
        let mut cmd = json!({ "type": "navigate_tree", "entryId": entry_id });
        if summarize {
            cmd["summarize"] = Value::Bool(true);
        }
        let timeout = if summarize {
            SUMMARIZE_TIMEOUT_MS
        } else {
            DEFAULT_REQUEST_TIMEOUT_MS
        };
        let res = self.tree_request(&proc, cmd, timeout).await?;
        let data = data_of(&res)?;
        if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
            return Ok(RewindOutcome {
                cancelled: true,
                editor_text: None,
            });
        }
        let editor_text = data
            .get("editorText")
            .and_then(Value::as_str)
            .map(str::to_string);
        let state = self.read_state_after_tree_change(&proc).await?;
        self.reload_after_tree_change(&proc, &state, false).await;
        Ok(RewindOutcome {
            cancelled: false,
            editor_text,
        })
    }

    /// Copies the chain up to `entry_id` into a new Conversation file (`fork`). The registry is pointed at that
    /// file before the transcript is rebuilt, and the lower message count is re-baselined so #449's notice stays silent.
    /// Returns the new file.
    pub async fn fork_conversation(&self, entry_id: &str) -> Result<String, AgentError> {
        let proc = self.tree_process("fork", true).await?;
        let previous = self.current_conversation_path().await;
        let res = self
            .tree_request(
                &proc,
                json!({ "type": "fork", "entryId": entry_id }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await?;
        let data = data_of(&res)?;
        if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
            return Err(tree_failed("the agent cancelled the fork"));
        }
        // Best-effort: a failed side-chat cancel must not undo the fork (#789).
        let _ = crate::session::side_chat::cancel(self).await;
        // The response carries no path: the new file is only in `get_state`.
        let state = match self.read_state_after_tree_change(&proc).await {
            Ok(state) => state,
            Err(err) => return Err(self.fail_attached(&proc, err).await),
        };
        let file = state
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|f| !f.is_empty())
            .map(str::to_string);
        let count = state
            .get("messageCount")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let Some(file) = file.filter(|_| count > 0) else {
            let err = AgentError::new(
                "reattach-failed",
                format!("fork left no Conversation to attach to (messageCount {count})"),
            );
            return Err(self.fail_attached(&proc, err).await);
        };
        if !self.fork_file_is_contained(&file).await {
            let err = AgentError::new(
                "reattach-failed",
                format!("fork reported a Conversation outside the Sessions folder: {file}"),
            );
            return Err(self.fail_attached(&proc, err).await);
        }
        let patch = SessionPatch {
            current_conversation: Some(Some(file.clone())),
            last_message_count: Some(Some(count)),
            ..Default::default()
        };
        if let Err(err) = self
            .registry
            .lock()
            .await
            .update_session(&self.session_id, patch)
            .await
        {
            let err = AgentError::new(
                "reattach-failed",
                super::launch_support::registry_store_error_message(err),
            );
            return Err(self.fail_attached(&proc, err).await);
        }
        let same_file = previous
            .as_deref()
            .is_some_and(|p| p.eq_ignore_ascii_case(&file));
        self.reload_after_tree_change(&proc, &state, !same_file)
            .await;
        Ok(file)
    }

    /// The registry will follow the new file, so it must be a `.jsonl` in the Session's folder or OMP's Sessions
    /// root. The parent folder is canonicalised rather than the file, which OMP may not have written yet.
    async fn fork_file_is_contained(&self, file: &str) -> bool {
        let path = Path::new(file);
        let is_jsonl = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"));
        let (Some(parent), Some(_), true) = (path.parent(), path.file_name(), is_jsonl) else {
            return false;
        };
        let Ok(parent) = tokio::fs::canonicalize(parent).await else {
            return false;
        };
        let session_dir = self
            .registry
            .lock()
            .await
            .get_session(&self.session_id)
            .and_then(|s| s.session_dir.clone())
            .filter(|d| !d.is_empty());
        let roots = session_dir
            .map(PathBuf::from)
            .into_iter()
            .chain(crate::ipc::conversations_delete::omp_sessions_root());
        for root in roots {
            if tokio::fs::canonicalize(&root)
                .await
                .is_ok_and(|root| parent.starts_with(root))
            {
                return true;
            }
        }
        false
    }

    async fn read_state_after_tree_change(&self, proc: &OmpProcess) -> Result<Value, AgentError> {
        let res = self
            .tree_request(
                proc,
                json!({ "type": "get_state" }),
                DEFAULT_REQUEST_TIMEOUT_MS,
            )
            .await?;
        data_of(&res).cloned()
    }

    /// The process now disagrees with the registry, so it is stopped and the Session shows `start-failed`,
    /// as a failed reattach does.
    async fn fail_attached(&self, proc: &OmpProcess, err: AgentError) -> AgentError {
        proc.stop().await;
        self.state.lock().await.process = None;
        self.record_start_failure(&err.message).await;
        AgentError::new("reattach-failed", err.message)
    }

    /// Rebuilds the transcript and the per-Conversation readouts from the process's active branch.
    async fn reload_after_tree_change(
        &self,
        proc: &OmpProcess,
        state_data: &Value,
        reset_side_chat: bool,
    ) {
        let file = state_data
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(str::to_string);
        let (messages, complete) = fetch_all_messages(proc).await;
        let note_live = super::queued_handoff::is_note_file(file.as_deref()).await;
        let records = self.checklist_send_records().await;
        {
            let mut state = self.state.lock().await;
            state.handoff.note_live = note_live;
            state.pending_agent_notice.clear();
            state.checklist_line_due = true;
            state.pause.cancelled.clear();
            let next = if complete {
                let mut fresh = TranscriptState::from_history(&messages);
                let _ = fresh.settle_interrupted_tool_rows();
                fresh
            } else {
                TranscriptState::new()
            };
            state.transcript.replace_keeping_lookup(next);
            super::queued_handoff::mark_note(&mut state);
            super::checklist_cards::reload(&mut state, &records);
        }
        // The old readout and subagent state describe another branch (#577).
        crate::session::readout::on_conversation_reset(self).await;
        if complete {
            crate::session::readout::on_history_loaded(self, &messages).await;
        }
        crate::session::subagents::on_conversation_reset(self).await;
        if reset_side_chat {
            crate::session::side_chat::on_conversation_reset(self).await;
        }
        crate::session::token_guard::on_conversation_reset(self, complete.then_some(&messages[..]))
            .await;
        self.sync_from_state(state_data, None).await;
        self.emit_patch_reset().await;
    }
}
