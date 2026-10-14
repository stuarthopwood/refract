// Model roles (lane RM, issues #454, #740, #741, #762, #766, #760): `set_model`, `cycle_model`,
// role records, pinning, `/switch`, `/model`, `/models`, `/role`, Ctrl+R, `/plan`, custom
// commands. Pre-declared so lane RM is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- one call per lane module each,
// cheap and allocation-free as a no-op; lane RM adds its model behaviour inside these functions,
// never inside any file under `session/agent/`.
//
// Design summary (FINDINGS "RM0 probe", items 51-57, `omp` 18.10.1; the full reasoning is in
// this lane's PR body under "Decisions"):
// - `set_model`/`cycle_model` are session-scoped RPC calls (FINDINGS item 51/54): neither writes
//   any role string other than `"default"` (or none), and `cycle_model` steps through literal,
//   version-adjacent catalog MODELS, never `cycleOrder`'s configured roles. Both PIN the Session
//   (#740/#454's shared pinning rule). The RPC's own `success` field is trustworthy for these
//   two, so no before/after verification is needed beyond it.
// - A role switch (`/role`, Ctrl+R, `/switch @<role>`) is forwarded to OMP's own native
//   `/switch @<role>` text command (FINDINGS item 54: proven to resolve the role alias
//   correctly) rather than Refract re-resolving `modelRoles`/`cycleOrder` itself (constitution
//   I's preference). Unlike `set_model`/`cycle_model`, OMP's native `/switch` text command
//   reports success even when it SILENTLY DOES NOTHING on an unresolvable argument (FINDINGS
//   item 53) -- so every text-command path (`handle_switch_text`, `apply_role_now`) reads
//   `get_state` before and after and only pins/records the change when the model actually moved
//   (gate-fix, HIGH: the first round of this lane trusted the text command's own ack).
// - Mid-turn safety is NOT provably safe (FINDINGS item 57's unnumbered closing entry: a clean
//   18.8.0 pass regressed to a provider 400 on 18.10.1 switching between two different real
//   models) -- every user-initiated switch (`set_model`, `cycle_model`, `/switch`, `/role`)
//   refuses outright while the Session is working, the same `SessionNotIdleError` pattern `/new`
//   already uses, never queues. Closing the race this needs (gate-fix, HIGH): the idle check and
//   the RPC/prompt dispatch happen under ONE lock acquisition (`agent::mod`'s own
//   `request_rpc_if_idle`/`send_if_idle`), not as two separate steps a concurrent turn start
//   could land between. The ONE exception is #740's own decided design for a Settings role
//   change reaching an open Session: that path queues for the Session's own next settle (never
//   refuses) via `queue_role_reapply_or_ready`, itself atomic with the status read for the same
//   reason.
// - A Session's tracked role is read from its own Conversation file's latest `model_change`
//   entry the first time it is needed each run (gate-fix, HIGH, #741: "if the role cannot be
//   established, show nothing rather than a guess" -- never default to `"default"` out of thin
//   air for a Session this run has never touched), then cached in memory (`State.current_role`)
//   so the file is never re-read on every `sessions.list()` poll. Pinning itself still has no
//   on-disk representation (FINDINGS item 51: `set_model` and a resolved role switch both write
//   the identical `role:"default"` shape), so it remains in-memory only and resets on restart --
//   documented in the PR, not silently worked around.
// - `/plan` is NOT built here: FINDINGS item 55 confirms no RPC route exists at all on 18.10.1
//   (no `set_mode`/`plan` command, `"plan": {"present": false}` on both a real and an isolated
//   profile) and #766 itself says plan mode must not ship as a role switch that merely claims to
//   be it. `/plan` stays in `NATIVE_RESERVED_COMMANDS` (`session::agent::commands`), refused
//   exactly as before this lane, pending #433's own spike.

use serde::Serialize;
use serde_json::{json, Value};

use crate::omp::process::ReadyWaitStage;
use crate::omp::transcript::NoticeLevel;

use super::agent::{AgentError, SessionAgent};

mod model_support;

// Re-exported at THIS path unchanged: `ipc::model`/`ipc::chat`/`session::manager` already call
// `crate::session::model::current_selection`/`known_role_list`. `is_switch_argument_token` stays
// restricted to `crate::session` (`session::agent::commands`/`agent::mod` are its only outside
// callers); the formatting/notice helpers below are used only by this file's own action
// functions, never re-exported further.
pub(in crate::session) use model_support::is_switch_argument_token;
pub use model_support::{current_selection, known_role_list};
use model_support::{friendly_model_text, model_selector_string, model_value, post_notice};

/// Mirrors `agent::mod`'s own `DEFAULT_REQUEST_TIMEOUT_MS` (private there); re-declared here
/// with the same value, same convention `omp::process.rs` itself documents for a value it does
/// not export.
const REQUEST_TIMEOUT_MS: u64 = 60_000;

/// Lane RM's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_model_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    /// True once the Session's model was chosen directly (the composer picker's `set_model`,
    /// `cycle_model`, or a typed `/switch <model>`/`/model <model>`) rather than via a role. A
    /// later Settings role change (#740) skips a pinned Session entirely. Choosing a role again
    /// (`/role`, Ctrl+R, `/switch @<role>`) un-pins it (#766).
    pub(super) pinned: bool,
    /// The role this Session is currently "on" (#741's composer chip, #740's "is this Session
    /// following role X" test). `None` until the first read (lazily seeded from the Session's
    /// own Conversation file the first time `current_selection` runs, gate-fix HIGH: never
    /// guessed as `"default"` -- #741's own rule, "show nothing rather than a guess").
    pub(super) current_role: Option<String>,
    /// Set when a role-following Session is mid-turn at the moment its role's model changes in
    /// Settings (#740's decided design: "automatic at the next idle moment", never refused).
    /// Applied by `on_frame` below at the Session's own next settle, then cleared.
    pub(super) pending_role_reapply: Option<String>,
    /// Gate-fix (HIGH, perf): the Conversation file path `current_selection` already probed and
    /// found NO `model_change` entry in, so a Session nobody has ever changed the model/role on
    /// is not re-read and re-parsed on every later `sessions.list()` poll. Distinct from
    /// `current_role` (which caches a FOUND role) -- this caches the negative result, keyed by
    /// path so a later Conversation (a genuinely new file) is still probed fresh.
    pub(super) role_probed_path: Option<String>,
    /// Monotonic id source for this lane's own transcript notices (`upsert_transcript_item`
    /// needs a stable, unique id per row; this lane posts no OMP frame of its own to derive one
    /// from the way `apply_frame`'s internal counter does for a `notice` frame).
    notice_seq: u64,
}

/// Issue #740: outcome of `session::manager::SessionManager::apply_role_change`'s sweep over
/// every live Session after a role's config value changes. Gate-fix (MEDIUM): named per bucket
/// (the Session's own display name), not just a count, so the Settings page's own polite result
/// can name which Sessions moved/were skipped (#740 acceptance: "a pinned Session... named in
/// the result").
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleChangeSummary {
    pub moved: Vec<String>,
    pub queued: Vec<String>,
    pub skipped_pinned: Vec<String>,
    /// Gate-fix (HIGH, tests): a Session whose live status is `Stopped` lands here -- neither
    /// moved nor failed, it simply resumes its saved model on its own next start, the same "new
    /// Sessions only" note the role-assignment page already carries for a start-time-only role.
    /// Tracked separately so the Settings summary never reports a misleading failure for a
    /// Session that is not actually running right now. This requires the Session to already
    /// have an AGENT ENTRY (a prior `.open()`, or even just a `model.listRoles`/`model.*` probe
    /// that called `get_or_create_agent` without starting it) -- a Session with no entry at all
    /// (truly untouched this run) is invisible to `apply_role_change`'s own `live_agents()` scan
    /// and so is not counted in ANY bucket here, moved/queued/skipped/failed alike; it still
    /// resumes its saved model on its own next real start, the same as a registered-but-stopped
    /// one.
    pub skipped_stopped: Vec<String>,
    pub failed: Vec<String>,
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    // Matches `agent::frame`'s own settle detection exactly (`"session_settled"`, or a
    // `prompt_result` whose own `sessionSettled` flag is set) -- by the time either fires,
    // `handle_turn_settled()` has already moved the Session back to `Idle` (frame.rs runs it
    // before this hook), so `apply_role_now`'s own `send_if_idle` call sees an idle Session.
    let settled = frame_type == "session_settled"
        || (frame_type == "prompt_result"
            && frame.get("sessionSettled").and_then(Value::as_bool) == Some(true));
    if !settled {
        return;
    }
    let pending = agent
        .with_model_state(|s| s.pending_role_reapply.take())
        .await;
    if let Some(role) = pending {
        // Gate-fix (MEDIUM, perf): run on a clone of the agent's own `Arc` rather than inline,
        // so the frame listener itself is never blocked waiting on this reapply's own RPCs
        // (`agent::frame`'s `handle_frame` already makes one inline RPC at settle time for
        // `on_session_settled`, which this deliberately does NOT add to).
        let agent = agent.arc();
        tokio::spawn(async move {
            // Gate-fix (HIGH, round 2): re-queue ONLY on `not-idle` (a genuine race -- the
            // Session started a new turn between the settle frame and this spawned task's own
            // `send_if_idle` call). Any OTHER error (the role's model is unavailable, not signed
            // in, or already current and unresolvable some other way) is FINAL: `apply_role_now`
            // has already posted its own Error notice for it, so re-queuing would repeat that
            // notice and the RPC round trip at every settle for the rest of the run instead of
            // surfacing it once.
            if let Err(err) = apply_role_now(&agent, &role, true).await {
                if err.code == "not-idle" {
                    agent
                        .with_model_state(|s| {
                            if s.pending_role_reapply.is_none() {
                                s.pending_role_reapply = Some(role);
                            }
                        })
                        .await;
                }
            }
        });
    }
}

pub(super) async fn on_exit(_agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    // No-op: nothing in this lane's state needs clearing on process exit (a resumed Session
    // reattaches to the SAME role/pin tracking, which is correct -- a pin or role choice is a
    // property of the Session, not of one process lifetime).
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: this lane has no start-progress banner content.
}

// ---------------------------------------------------------------------------
// User-initiated actions (composer picker, `/switch`, `/role`, Ctrl+R).
// ---------------------------------------------------------------------------

/// #454: the composer's model picker. Session-scoped only (OMP's own `set_model` description,
/// "for this session only" -- never writes `modelRoles` or any other config); pins the Session
/// and clears any tracked role. Refuses while working (see this file's header). The RPC's own
/// `success` field is authoritative here (unlike the native `/switch` TEXT command, this one
/// genuinely fails when the model does not resolve), so no before/after comparison is needed.
pub async fn set_model(
    agent: &SessionAgent,
    provider: &str,
    model_id: &str,
) -> Result<Value, AgentError> {
    let res = agent
        .request_rpc_if_idle(
            json!({ "type": "set_model", "provider": provider, "modelId": model_id }),
            REQUEST_TIMEOUT_MS,
            "Switch the model",
        )
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Model not found.")
            .to_string();
        return Err(AgentError::new("prompt-failed", message));
    }
    let data = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!(
                "Model switched, but the new state could not be confirmed: {}",
                err.message
            ),
        )
    })?;
    let model = model_value(&data).ok_or_else(|| {
        AgentError::new(
            "prompt-failed",
            "Model switched, but the new model could not be read.",
        )
    })?;
    agent
        .with_model_state(|s| {
            s.pinned = true;
            s.current_role = None;
            s.pending_role_reapply = None;
        })
        .await;
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Model switched to {}.", friendly_model_text(&data)),
    )
    .await;
    Ok(json!({ "model": model }))
}

/// #454's own keyboard/toolbar cycle: steps the live Session through OMP's `cycle_model` RPC
/// command. FINDINGS item 54: this is NOT a role cycle -- it moves through literal,
/// version-adjacent catalog models unrelated to `cycleOrder`'s roles, so it pins the Session
/// exactly like `set_model` (a concrete model was just chosen, not a role). Refuses while
/// working, same rule as `set_model`. The RPC's own `success` field is authoritative (same
/// reasoning as `set_model`).
pub async fn cycle_model(agent: &SessionAgent) -> Result<Value, AgentError> {
    let res = agent
        .request_rpc_if_idle(
            json!({ "type": "cycle_model" }),
            REQUEST_TIMEOUT_MS,
            "Switch the model",
        )
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Could not switch models.")
            .to_string();
        return Err(AgentError::new("prompt-failed", message));
    }
    let data = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!(
                "Model switched, but the new state could not be confirmed: {}",
                err.message
            ),
        )
    })?;
    let model = model_value(&data).ok_or_else(|| {
        AgentError::new(
            "prompt-failed",
            "Model switched, but the new model could not be read.",
        )
    })?;
    agent
        .with_model_state(|s| {
            s.pinned = true;
            s.current_role = None;
            s.pending_role_reapply = None;
        })
        .await;
    post_notice(
        agent,
        NoticeLevel::Info,
        format!("Model switched to {}.", friendly_model_text(&data)),
    )
    .await;
    Ok(json!({ "model": model }))
}

/// Shared apply path for every role switch (user-initiated `apply_role` below, and #740's own
/// automatic settle-time reapply). Always forwards OMP's own native `/switch @<role>` text
/// command (FINDINGS item 54; constitution I: Refract does not reimplement `modelRoles`/
/// `cycleOrder` resolution when OMP already does it) rather than calling `set_model` with a
/// selector Refract resolved itself. Gate-fix (HIGH): reads `get_state` before and after and
/// only pins/records the role when the model genuinely changed -- OMP's own `/switch` reports
/// success even when it silently does nothing (FINDINGS item 53), so the ack alone is not proof.
/// `settings_triggered` controls the EXTRA transcript notice (#740 item 3: "Model changed from X
/// to Y: the <role> role was changed in Settings") -- the user-initiated path gets no extra
/// notice of its own, since OMP's `command_output` for `/switch` already confirms a real change
/// ("Session-only model: ..."). Always goes through `send_if_idle` (gate-fix, HIGH, race): a
/// `not-idle` result here is not necessarily a hard failure for the settings-triggered caller,
/// which re-queues on it (see `on_frame`/`SessionManager::apply_role_change`).
pub async fn apply_role_now(
    agent: &SessionAgent,
    role: &str,
    settings_triggered: bool,
) -> Result<Value, AgentError> {
    // Gate-fix (LOW, security): `role` only has to match a `cycleOrder` entry from the user's
    // own global OMP config (`apply_role`'s own validation, and the settle/sweep callers below,
    // never check characters) before reaching here -- an entry containing whitespace or another
    // disallowed character would otherwise forward free text past the allow-list this lane's
    // own `/switch` path enforces everywhere else.
    if !is_switch_argument_token(&format!("@{role}")) {
        return Err(AgentError::new(
            "invalid-argument",
            format!("Role \"{role}\" contains characters `/switch` cannot forward."),
        ));
    }
    let before = agent.refresh_from_state().await.ok();
    // Gate-fix (MEDIUM): `send_if_idle`'s own atomic check only sees Refract's own status,
    // which is set to `Working` only once the `agent_start` frame arrives -- a prompt just
    // admitted by OMP but not yet reflected in that status would still look idle here. The
    // `get_state` just fetched above is live, so refuse on its own `isStreaming` flag too,
    // closing that narrower window.
    if before
        .as_ref()
        .and_then(|v| v.get("isStreaming"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(AgentError::new(
            "not-idle",
            "Session is busy: a response is still streaming.",
        ));
    }
    let before_text = before.as_ref().map(friendly_model_text);
    agent.send_if_idle(format!("/switch @{role}"), None).await?;
    let after = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!("Could not confirm the role switch: {}", err.message),
        )
    })?;
    let after_model = model_value(&after).ok_or_else(|| {
        AgentError::new(
            "prompt-failed",
            "Could not read the model after switching roles.",
        )
    })?;
    let before_model = before.as_ref().and_then(model_value);
    if before_model.as_ref() == Some(&after_model) {
        // Gate-fix (HIGH): not necessarily a failure -- picking a role whose own configured
        // model is already the live one (Ctrl+R onto the current role, or two roles mapped to
        // the same selector) is a valid no-op switch, and #766's "choosing a role again
        // un-pins" must still succeed for it. Only report failure when the role's own
        // `modelRoles` selector does NOT match the model that is actually live -- the genuine
        // case OMP's native `/switch` silently no-ops on (FINDINGS item 53).
        let role_resolves_to_current = match (
            crate::ipc::model_roles::get_model_roles()
                .await
                .ok()
                .and_then(|roles| roles.get(role).cloned()),
            model_selector_string(&after_model),
        ) {
            (Some(selector), Some(current)) => selector == current,
            _ => false,
        };
        if !role_resolves_to_current {
            let message = format!(
                "Role \"{role}\" could not be applied: the model is still {}.",
                friendly_model_text(&after)
            );
            if settings_triggered {
                post_notice(agent, NoticeLevel::Error, message.clone()).await;
            }
            return Err(AgentError::new("prompt-failed", message));
        }
    }
    agent
        .with_model_state(|s| {
            s.pinned = false;
            s.current_role = Some(role.to_string());
            s.pending_role_reapply = None;
        })
        .await;
    if settings_triggered {
        let before_text = before_text.unwrap_or_else(|| "its previous model".to_string());
        post_notice(
            agent,
            NoticeLevel::Info,
            format!(
                "Model changed from {before_text} to {}: the \"{role}\" role was changed in Settings.",
                friendly_model_text(&after)
            ),
        )
        .await;
    }
    Ok(json!({ "model": after_model, "role": role }))
}

/// #766: `/role <role>`, the Ctrl+R selector, and a role chip click all land here. `role` is
/// validated against `known_roles` BEFORE anything is sent (FINDINGS item 53's documented gap:
/// OMP's own `/switch @<role>` silently no-ops on an unknown role rather than erroring). The
/// working/idle decision itself is `apply_role_now`'s own atomic `send_if_idle` call -- this
/// never pre-checks separately (gate-fix, HIGH, race).
pub async fn apply_role(
    agent: &SessionAgent,
    role: &str,
    known_roles: &[String],
) -> Result<Value, AgentError> {
    if !known_roles.iter().any(|r| r == role) {
        return Err(AgentError::new(
            "invalid-argument",
            format!(
                "Unknown role: {role}. Valid roles: {}",
                known_roles.join(", ")
            ),
        ));
    }
    apply_role_now(agent, role, false).await
}

/// `/switch <arg>` and its `/model <arg>` alias (`ipc::chat` rewrites `/model` to `/switch`
/// before this ever runs). Gate-fix (HIGH/MEDIUM, security): the charset/length token check runs
/// INSIDE this function (not only `session::agent::commands`'s own `classify_against_builtin`),
/// so a repo-supplied custom command that somehow claimed the name `switch` (defence in depth:
/// `commands.rs`'s own `filter_supported_commands` now also seeds `"switch"` into its
/// builtin-claimed set so that can never happen through the menu/classification path either)
/// still cannot forward unchecked text through this lane's own pin/role bookkeeping. `arg` is
/// empty for a bare, read-only `/switch` (FINDINGS item 53: always just echoes the current
/// model); a `@role` alias routes through the exact same validated path `apply_role` uses
/// (gate-fix, HIGH: this used to record `current_role` from the raw stripped text with no
/// validation at all); anything else is a direct model token, verified via the same
/// before/after `get_state` comparison `apply_role_now` uses, and pins the Session on success.
/// Always returns `{queued: false}` (gate-fix, HIGH: `chat.send`'s own wire type is
/// `Result<{queued: boolean}>`; the richer `{model, role}` shape is for `ipc::model`'s own
/// direct `applyRole`/`setModel` callers only, never this text-command path).
pub async fn handle_switch_text(agent: &SessionAgent, arg: &str) -> Result<Value, AgentError> {
    if !arg.is_empty() && !is_switch_argument_token(arg) {
        return Err(AgentError::new(
            "invalid-argument",
            "/switch takes a single model or role token (letters, digits, and ._:/@-, no leading -, no spaces).",
        ));
    }
    if arg.is_empty() {
        return agent.send_if_idle("/switch".to_string(), None).await;
    }
    if let Some(role) = arg.strip_prefix('@') {
        let known_roles = known_role_list().await?;
        apply_role(agent, role, &known_roles).await?;
        return Ok(json!({ "queued": false }));
    }
    let before = agent.refresh_from_state().await.ok();
    // Gate-fix (MEDIUM): same narrower race `apply_role_now` closes above -- `send_if_idle`'s
    // own atomic check only sees Refract's own status, not OMP's live `isStreaming` flag, which
    // the `get_state` just fetched above already carries.
    if before
        .as_ref()
        .and_then(|v| v.get("isStreaming"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(AgentError::new(
            "not-idle",
            "Session is busy: a response is still streaming.",
        ));
    }
    agent.send_if_idle(format!("/switch {arg}"), None).await?;
    let after = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!("Could not confirm the model switch: {}", err.message),
        )
    })?;
    let after_model = model_value(&after).ok_or_else(|| {
        AgentError::new("prompt-failed", "Could not read the model after switching.")
    })?;
    let before_model = before.as_ref().and_then(model_value);
    if before_model.as_ref() == Some(&after_model) {
        // Gate-fix (HIGH): a token that already names the live model (retyping the current
        // model, or the same selector with a thinking-level suffix OMP accepted without
        // changing the model itself) is a valid no-op, not a failure -- only a token that does
        // NOT match the live model at all is the genuine "could not be resolved" case (FINDINGS
        // item 53: OMP's native `/switch` silently no-ops on an unresolvable argument).
        let base_token = arg.split(':').next().unwrap_or(arg);
        let token_resolves_to_current =
            model_selector_string(&after_model).as_deref() == Some(base_token);
        if !token_resolves_to_current {
            return Err(AgentError::new(
                "prompt-failed",
                format!("Model unchanged: \"{arg}\" could not be resolved."),
            ));
        }
    }
    agent
        .with_model_state(|s| {
            s.pinned = true;
            s.current_role = None;
            s.pending_role_reapply = None;
        })
        .await;
    Ok(json!({ "queued": false }))
}
