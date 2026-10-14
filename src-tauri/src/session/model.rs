// Model roles (lane RM, issues #454, #740, #741, #762, #766, #760): `set_model`, `cycle_model`,
// role records, pinning, `/switch`, `/model`, `/models`, `/role`, Ctrl+R, `/plan`, custom
// commands. Pre-declared so lane RM is the only lane that ever edits this file (issue #784,
// "Pre-declare per-lane Rust files").
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- cheap, allocation-free
// no-ops; lane RM adds its model behaviour inside these functions, never under `session/agent/`.
//
// Design summary (FINDINGS "RM0 probe", items 51-57, `omp` 18.10.1; full reasoning in the PR body "Decisions"):
// - `set_model`/`cycle_model` are session-scoped RPC calls (FINDINGS item 51/54): neither writes
//   any role string other than `"default"` (or none), and `cycle_model` steps through literal,
//   version-adjacent catalog MODELS, never `cycleOrder`'s configured roles. Both PIN the Session
//   (#740/#454's shared pinning rule). The RPC's own `success` field is trustworthy for these
//   two, so no before/after verification is needed beyond it.
// - A role switch (`/role`, Ctrl+R, `/switch @<role>`) is forwarded to OMP's own native
//   `/switch @<role>` text command (FINDINGS item 54: proven to resolve the role alias
//   correctly) rather than Refract re-resolving `modelRoles`/`cycleOrder` itself. Unlike
//   `set_model`/`cycle_model`, OMP's native `/switch` reports success even when it SILENTLY
//   DOES NOTHING on an unresolvable argument (FINDINGS item 53) -- every text-command path
//   reads `get_state` before/after (`refresh_state_or_refuse`/same-model check) and only
//   pins/records a genuine change.
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
//   established, show nothing rather than a guess"), then cached in memory (`State.current_role`,
//   and a negative result too via `State.role_probed_path`) so the file is never re-read on
//   every `sessions.list()` poll. Pinning has no on-disk representation (FINDINGS item 51), so
//   it remains in-memory only and resets on restart -- documented, not silently worked around.
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

pub(in crate::session) mod model_support;

// Gate-fix (round 5): `is_switch_argument_token` is no longer re-exported at this path --
// `session::agent::commands`'s own `classify_against_builtin` imports it directly from its real
// module (`crate::session::model::model_support::is_switch_argument_token`, reachable now that
// `mod model_support` above is `pub(in crate::session)`). Every other helper below is used only
// by this file's own action functions, never re-exported.
use model_support::{
    friendly_model_text, is_switch_argument_token, model_value, post_notice, selector_matches_model,
};

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
        // so the frame listener itself is never blocked waiting on this reapply's own RPCs.
        // Gate-fix (#856): `agent::frame`'s own `handle_turn_settled` used to make one inline
        // RPC at settle time for `on_session_settled` too -- that one is ALSO spawned off the
        // listener task now (same file), so this reapply no longer needs to share that worry.
        let agent = agent.arc();
        tokio::spawn(async move {
            // Gate-fix (HIGH, round 2): re-queue ONLY on `not-idle` (a genuine race -- the
            // Session started a new turn between the settle frame and this spawned task's own
            // `send_if_idle` call). Any OTHER error (the role's model is unavailable, not signed
            // in, or already current and unresolvable some other way) is FINAL: `apply_role_now`
            // has already posted its own Error notice for it, so re-queuing would repeat that
            // notice and the RPC round trip at every settle for the rest of the run instead of
            // surfacing it once.
            if let Err(err) = apply_role_now(&agent, &role, true, None).await {
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
// Role lookup (Session's own tracked role, `cycleOrder`, and `/role`'s validation set).
// ---------------------------------------------------------------------------

/// Reads the Session's own current Conversation file (if any) for its LATEST `model_change`
/// entry's `role` (FINDINGS item 51: `set_model`/`open_session`-override always write an
/// explicit `role:"default"`; `cycle_model` omits `role` entirely -- both reconstruct to
/// `"default"` per the same finding). `None` when the file has no `model_change` entry at all
/// (nothing has ever touched this Session's model this Conversation) or cannot be read --
/// callers must not guess `"default"` for that case (#741: "if the role cannot be established,
/// show nothing rather than a guess"). Reads the whole file once (cached by the caller into
/// `State.current_role` so this never repeats for the same Session/Conversation; a NOT-found
/// result is cached too, by path, in `State.role_probed_path` -- gate-fix HIGH/perf).
async fn read_role_from_session_file(conversation_path: &str) -> Option<String> {
    let content = tokio::fs::read_to_string(conversation_path).await.ok()?;
    let mut latest: Option<String> = None;
    for line in content.lines() {
        let line = line.trim();
        // Gate-fix (HIGH, perf): skip the `serde_json::from_str` parse entirely for the common
        // case -- most lines in a long-running Conversation are not `model_change` entries, and
        // a plain substring scan is far cheaper than parsing JSON just to discard it.
        if line.is_empty() || !line.contains("model_change") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("model_change") {
            latest = Some(
                value
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    .to_string(),
            );
        }
    }
    latest
}

/// Read access to this lane's own per-Session state, for `ipc::model` (the role selector's
/// listing), `session::manager` (the #740 propagation sweep), and `ipc::chat` (the `/role`
/// interception) -- all outside this module's own tree, so this wraps `with_model_state` in a
/// `pub` function rather than widening the `State` struct's own fields to `pub`. Lazily seeds
/// `current_role` from the Session's own Conversation file on the first call this run (gate-fix,
/// HIGH, #741: never a guessed `"default"`), then returns the cached value on every later call.
/// Gate-fix (HIGH, perf): a Session whose Conversation has no `model_change` entry at all (the
/// common case) used to re-read and re-parse the WHOLE file on every call (every
/// `sessions.list()` poll, one Session at a time); the negative result is now cached too, keyed
/// by the probed path, so a later call for the SAME Conversation returns immediately, while a
/// genuinely new Conversation (a different path) is still probed fresh.
pub async fn current_selection(agent: &SessionAgent) -> (bool, Option<String>) {
    let (pinned, cached_role) = agent
        .with_model_state(|s| (s.pinned, s.current_role.clone()))
        .await;
    if pinned || cached_role.is_some() {
        return (pinned, cached_role);
    }
    let Some(path) = agent.current_conversation_path().await else {
        return (pinned, None);
    };
    let already_probed = agent
        .with_model_state(|s| s.role_probed_path.as_deref() == Some(path.as_str()))
        .await;
    if already_probed {
        return (pinned, None);
    }
    let role = read_role_from_session_file(&path).await;
    if let Some(role) = role.clone() {
        agent
            .with_model_state(|s| {
                if s.current_role.is_none() {
                    s.current_role = Some(role);
                }
            })
            .await;
    } else {
        agent
            .with_model_state(|s| s.role_probed_path = Some(path.clone()))
            .await;
    }
    (pinned, role)
}

/// `cycleOrder` (read fresh every call) plus `"plan"` (#766, Stuart's own decided design,
/// 2026-10-13: "Ctrl+R cycles OMP's `cycleOrder` roles plus `plan`") -- the Ctrl+R selector's
/// own listing and cycling order. Narrower than `known_chat_role_list` below on purpose.
pub async fn known_role_list() -> Result<Vec<String>, AgentError> {
    let response = crate::omp::config::get_config("cycleOrder", &[])
        .await
        .map_err(|err| AgentError::new("omp-probe-failed", err.to_string()))?;
    let cycle_order = model_support::parse_cycle_order_response(&response)
        .map_err(|msg| AgentError::new("omp-probe-failed", msg))?;
    Ok(model_support::build_role_list(&cycle_order))
}

/// Gate-fix (round 5, #766): the ONE validation set for `/role <role>` and `/switch @<role>`
/// -- `cycleOrder` + `plan` + the core chat roles (only when configured in `modelRoles`, so
/// `/role smol` still validates with `smol` removed from `cycleOrder`) + any CUSTOM role
/// configured in `modelRoles` (workload/model-kind roles #766 excludes). Ctrl+R stays narrower
/// (`known_role_list` above, decided). A custom role name with a character outside
/// `is_switch_argument_token`'s own charset validates here but is refused by `/switch @<name>`
/// (whose charset check covers the whole token) -- a real asymmetry, not a bug.
/// The two `omp` reads run SEQUENTIALLY (`try_join!` intermittently excluded a role) and go
/// through `OMP_INVOCATION_LOCK` (process-wide). Round 7: an empty `modelRoles` read is
/// retried once (`get_model_roles_reliable`); if still empty, accepted as genuine (a real
/// unconfigured profile) rather than guessed at -- `cycleOrder` always has a non-empty default
/// regardless of `modelRoles`, so its presence is not a usable "this profile is configured"
/// signal (round 7 follow-up, caught in review).
pub async fn known_chat_role_list() -> Result<Vec<String>, AgentError> {
    let roles = known_role_list().await?;
    let model_roles = crate::ipc::model_roles::get_model_roles_reliable()
        .await
        .map_err(|err| AgentError::new("omp-probe-failed", err.to_string()))?;
    let merged = model_support::merge_chat_roles(roles, &model_roles);
    log::debug!(
        "known_chat_role_list: model_roles_keys={} merged={merged:?}",
        model_roles.len()
    );
    Ok(merged)
}

// ---------------------------------------------------------------------------
// User-initiated actions (composer picker, `/switch`, `/role`, Ctrl+R).
// ---------------------------------------------------------------------------

/// Shared RPC dance for `set_model`/`cycle_model` below (gate-fix, file-size): both choose a
/// concrete MODEL (never a role, FINDINGS item 51/54), pin the Session identically, and trust
/// the RPC's own `success` field (unlike the native `/switch` TEXT command, both genuinely fail
/// when the model does not resolve, so no before/after `get_state` comparison is needed here).
async fn pick_model_via_rpc(
    agent: &SessionAgent,
    cmd: Value,
    not_found_message: &str,
) -> Result<Value, AgentError> {
    let res = agent
        .request_rpc_if_idle(cmd, REQUEST_TIMEOUT_MS, "Switch the model")
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or(not_found_message)
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

/// #454: the composer's model picker. Session-scoped only (OMP's own `set_model` description,
/// "for this session only" -- never writes `modelRoles` or any other config); pins the Session
/// and clears any tracked role. Refuses while working (see this file's header).
pub async fn set_model(
    agent: &SessionAgent,
    provider: &str,
    model_id: &str,
) -> Result<Value, AgentError> {
    pick_model_via_rpc(
        agent,
        json!({ "type": "set_model", "provider": provider, "modelId": model_id }),
        "Model not found.",
    )
    .await
}

/// #454's own keyboard/toolbar cycle: steps the live Session through OMP's `cycle_model` RPC
/// command. FINDINGS item 54: this is NOT a role cycle -- it moves through literal,
/// version-adjacent catalog models unrelated to `cycleOrder`'s roles, so it pins the Session
/// exactly like `set_model` (a concrete model was just chosen, not a role). Refuses while
/// working, same rule as `set_model`.
pub async fn cycle_model(agent: &SessionAgent) -> Result<Value, AgentError> {
    pick_model_via_rpc(
        agent,
        json!({ "type": "cycle_model" }),
        "Could not switch models.",
    )
    .await
}

/// Shared pre-switch guard for `apply_role_now`/`handle_switch_text` below (gate-fix, MEDIUM):
/// fetches `get_state` and refuses outright rather than silently falling through to the success
/// path on failure (`before_model.as_ref() == Some(&after_model)` would be trivially false for
/// a missing `before`, recording a role/pin change neither function actually verified), or if
/// the Session's own live `isStreaming` flag is set -- `send_if_idle`'s own atomic check only
/// sees Refract's own status, set to `Working` only once the `agent_start` frame arrives, so a
/// prompt just admitted by OMP but not yet reflected there would still look idle to it.
async fn refresh_state_or_refuse(agent: &SessionAgent) -> Result<Value, AgentError> {
    let state = agent.refresh_from_state().await.map_err(|err| {
        AgentError::new(
            "prompt-failed",
            format!(
                "Could not confirm the Session's current model: {}",
                err.message
            ),
        )
    })?;
    if state.get("isStreaming").and_then(Value::as_bool) == Some(true) {
        return Err(AgentError::new(
            "not-idle",
            "Session is busy: a response is still streaming.",
        ));
    }
    Ok(state)
}

/// Shared apply path for every role switch (user-initiated `apply_role` below, and #740's own
/// automatic settle-time reapply). Always forwards OMP's own native `/switch @<role>` text
/// command (FINDINGS item 54; constitution I: Refract does not reimplement `modelRoles`/
/// `cycleOrder` resolution when OMP already does it). Gate-fix (HIGH): reads `get_state` before
/// and after and only pins/records the role when the model genuinely changed -- OMP's own
/// `/switch` reports success even when it silently does nothing (FINDINGS item 53).
/// `settings_triggered` controls the EXTRA transcript notice (#740 item 3); the user-initiated
/// path gets no extra notice, since OMP's own `command_output` for `/switch` already confirms a
/// real change. Always goes through `send_if_idle` (gate-fix, HIGH, race): a `not-idle` result
/// is not necessarily a hard failure for the settings-triggered caller, which re-queues on it.
pub async fn apply_role_now(
    agent: &SessionAgent,
    role: &str,
    settings_triggered: bool,
    cached_model_roles: Option<&std::collections::HashMap<String, String>>,
) -> Result<Value, AgentError> {
    // Gate-fix (LOW, security): `role` only has to match a `cycleOrder` entry from the user's own
    // global OMP config (callers below never check characters) before reaching here -- an entry
    // with whitespace or another disallowed character would otherwise forward free text past the
    // allow-list this lane's own `/switch` path enforces everywhere else.
    if !is_switch_argument_token(&format!("@{role}")) {
        return Err(AgentError::new(
            "invalid-argument",
            format!("Role \"{role}\" contains characters `/switch` cannot forward."),
        ));
    }
    let before = refresh_state_or_refuse(agent).await?;
    let before_text = friendly_model_text(&before);
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
    let before_model = model_value(&before);
    if before_model.as_ref() == Some(&after_model) {
        // Gate-fix (HIGH): a role whose own model is already live (Ctrl+R onto the current
        // role, two roles mapped to one selector) is a valid no-op, not a failure; #766's
        // "choosing a role again un-pins" must still succeed for it. Only fails when the role's
        // own selector (`model_support::resolve_role_selector`, below) does NOT match the live
        // model (FINDINGS item 53). Gate-fix (round 7): a FAILED read no longer swallows into
        // that message, surfacing via `?`. `cached_model_roles` (the #740 sweep's single fetch)
        // is used when present.
        let fetched;
        let model_roles = match cached_model_roles {
            Some(map) => map,
            None => {
                fetched = crate::ipc::model_roles::get_model_roles_reliable()
                    .await
                    .map_err(|err| AgentError::new("omp-probe-failed", err.to_string()))?;
                &fetched
            }
        };
        let role_resolves_to_current = model_support::resolve_role_selector(model_roles, role)
            .is_some_and(|selector| selector_matches_model(selector, &after_model));
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
    apply_role_now(agent, role, false, None).await
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
        // Gate-fix (round 5, #766): the SAME validation set `/role <role>` uses, not the
        // narrower Ctrl+R cycling list -- a `@role` alias forward should accept exactly what
        // the text command does.
        let known_roles = known_chat_role_list().await?;
        apply_role(agent, role, &known_roles).await?;
        return Ok(json!({ "queued": false }));
    }
    let before = refresh_state_or_refuse(agent).await?;
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
    let before_model = model_value(&before);
    if before_model.as_ref() == Some(&after_model) {
        // Gate-fix (HIGH): a token that already names the live model (retyping the current
        // model, or the same selector with a thinking-level suffix OMP accepted without
        // changing the model itself) is a valid no-op, not a failure -- only a token that does
        // NOT match the live model at all is the genuine "could not be resolved" case (FINDINGS
        // item 53: OMP's native `/switch` silently no-ops on an unresolvable argument).
        if !selector_matches_model(arg, &after_model) {
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
