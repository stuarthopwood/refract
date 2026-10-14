// Golden contract-replay test (issue #795 part 3, R12b): replays the `session` scenario tape
// (`scripts/fixtures/omp-frames/session.jsonl`, R12a/#795 parts 1-2) through a REAL
// `ipc::Dispatcher`/`AppState`/`SessionAgent`/`OmpProcess` -- no Tauri window, no WebView2/CDP,
// no cargo-managed binary -- by spawning the recorded-frame fake `omp`
// (`scripts/verify-tauri-fake-omp.mjs`) behind the native PATH shim
// (`scripts/verify-tauri-omp-shim.rs`, compiled here with a bare, non-Cargo `rustc` call so it
// never touches `CARGO_TARGET_DIR` or its shared lock).
//
// This asserts the captured, normalized trace of IPC response envelopes plus transcript
// snapshots equals a checked-in golden file
// (`scripts/fixtures/contract-replay/session-scenario.rust-trace.json`) -- a diff against a
// FROZEN prior-good run, not a live recompute of "what did this just produce" (which would
// prove nothing). See `scripts/fixtures/contract-replay/README.md` for the normalization rules
// and how to regenerate the golden file.
//
// Why PATH-shimming, not `OmpProcessOptions.omp_path`: `session::agent::launch::launch` (R3,
// issue #786, not owned by this lane) always builds `OmpProcessOptions::new(...)`, which leaves
// `omp_path: None` -- there is no public seam to inject an override from outside that module.
// `omp::process::OmpProcess::connect` falls back to `process::executables::resolve_omp()`,
// which is a plain, process-lifetime-cached `which::which_global("omp")` PATH lookup (see that
// function's own doc comment) -- so prepending a scratch directory containing a shim `omp.exe`
// onto this test process's own `PATH` *before* the first spawn, exactly mirrors what
// `scripts/verify-tauri.mjs` does for the full CDP harness, with no Rust source change needed.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use refract_tauri_lib::events::EventSink;
use refract_tauri_lib::ipc::{register_handlers, AppState, Dispatcher};
use refract_tauri_lib::session::{SessionManager, SessionStatus};
use refract_tauri_lib::store::registry::RegistryStore;
use refract_tauri_lib::store::settings::SettingsStore;

/// Never `verify-tauri.mjs`'s own `PROMPT_MESSAGE`/`REPLY_TOKEN` (deliberately -- the fixture's
/// `$lastMessage` sentinel echoes back whatever this test actually sends, it does not need to
/// match any other harness's literal text).
const PROMPT_MESSAGE: &str = "Create note.txt with the text 'hi', then tell me the token xyzzy9.";

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_root() -> PathBuf {
    manifest_dir()
        .parent()
        .expect("src-tauri has a parent directory")
        .to_path_buf()
}

fn run_git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git must be on PATH for this test");
    assert!(status.success(), "git {args:?} failed in {dir:?}");
}

/// A fresh scratch git repository with one commit on `main`. Mirrors
/// `git::test_support::init_repo`'s own recipe exactly, but cannot call that helper directly:
/// it is `pub(crate)`, invisible to this external integration-test crate (`tests/` binaries only
/// ever see the library's `pub` surface).
fn make_scratch_repo() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "refract-contract-replay-repo-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create scratch repo dir");
    run_git(&dir, &["init", "--initial-branch=main", "-q"]);
    run_git(
        &dir,
        &["config", "user.email", "contract-replay@example.invalid"],
    );
    run_git(&dir, &["config", "user.name", "contract-replay"]);
    std::fs::write(dir.join("README.md"), b"seed\n").expect("write seed file");
    run_git(&dir, &["add", "."]);
    run_git(&dir, &["commit", "-q", "-m", "seed"]);
    dir
}

/// Compiles `scripts/verify-tauri-omp-shim.rs` into `<dir>/omp.exe` with the exact bare `rustc`
/// invocation `scripts/verify-tauri.mjs`'s own `buildOmpShim` uses: no Cargo project, so this
/// never touches `CARGO_TARGET_DIR` or its shared lock, and takes well under a second.
fn build_omp_shim(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).expect("create shim dir");
    let src = repo_root()
        .join("scripts")
        .join("verify-tauri-omp-shim.rs");
    assert!(
        src.is_file(),
        "contract_replay: expected shim source at {}",
        src.display()
    );
    let out = dir.join("omp.exe");
    let output = Command::new("rustc")
        .args(["--edition", "2021", "-O"])
        .arg(&src)
        .arg("-o")
        .arg(&out)
        .output()
        .expect("spawn rustc");
    assert!(
        output.status.success(),
        "build_omp_shim: rustc failed (exit {:?}):\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    out
}

/// Same `make_state` pattern `ipc::repositories_tests`/`ipc::sessions_lifecycle_tests` already
/// use (their own header comments call this out as the one shared construction recipe).
async fn make_state(dir: &Path) -> AppState {
    let registry = RegistryStore::open(dir).await.expect("open registry");
    let settings = SettingsStore::open(dir).await.expect("open settings");
    let registry = Arc::new(AsyncMutex::new(registry));
    let settings = Arc::new(AsyncMutex::new(settings));
    let app_handle_slot: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(app_handle_slot.clone(), registry.clone());
    let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
    AppState {
        data_dir: dir.to_path_buf(),
        registry,
        settings,
        app_handle: app_handle_slot,
        session_manager,
    }
}

async fn wait_for_status(
    agent: &refract_tauri_lib::session::SessionAgent,
    target: SessionStatus,
    timeout: Duration,
) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let current = agent.status().await;
        if current == target {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "contract_replay: timed out after {timeout:?} waiting for status {target:?} (last seen {current:?})"
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 24-byte `new Date().toISOString()` shape (`ipc::now_iso8601`'s own format): exact length plus
/// digit/separator positions, no regex dependency needed for this one fixed pattern.
fn is_iso8601_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 24 {
        return false;
    }
    let digit = |i: usize| b[i].is_ascii_digit();
    (0..4).all(digit)
        && b[4] == b'-'
        && (5..7).all(digit)
        && b[7] == b'-'
        && (8..10).all(digit)
        && b[10] == b'T'
        && (11..13).all(digit)
        && b[13] == b':'
        && (14..16).all(digit)
        && b[16] == b':'
        && (17..19).all(digit)
        && b[19] == b'.'
        && (20..23).all(digit)
        && b[23] == b'Z'
}

/// Normalizes every run-to-run-nondeterministic value in the captured trace before comparing it
/// to the frozen golden file: scratch-repo/worktree paths, the repository/Session uuids, the
/// randomly generated branch name (`git::worktrees::add_worktree_with_generated_name`), any
/// `now_iso8601()` timestamp, and the real-wall-clock `startedAt`/`durationMs` fields
/// `omp::transcript`'s own `now_ms()` stamps onto `Tool`/`Subagent` transcript rows (none of
/// which the fixture tape itself ever supplies -- they are this crate's own bookkeeping, not
/// replayed wire data). `dynamic` is applied longest-string-first so a longer match (e.g. the
/// full worktree path) is replaced before a shorter one it happens to contain (e.g. the bare
/// repository folder name) can partially corrupt it.
fn normalize(value: &mut Value, dynamic: &[(String, &'static str)]) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map.iter_mut() {
                if matches!(key.as_str(), "startedAt" | "endedAt" | "durationMs") && !inner.is_null()
                {
                    *inner = json!("<TIMESTAMP_MS>");
                    continue;
                }
                normalize(inner, dynamic);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                normalize(item, dynamic);
            }
        }
        Value::String(s) => {
            for (needle, placeholder) in dynamic {
                if !needle.is_empty() && s.contains(needle.as_str()) {
                    *s = s.replace(needle.as_str(), placeholder);
                }
            }
            if is_iso8601_timestamp(s) {
                *s = "<TIMESTAMP>".to_string();
            }
        }
        _ => {}
    }
}

fn ipc_step(channel: &str, args: &Value, response: &Value) -> Value {
    json!({ "kind": "ipc", "channel": channel, "args": args, "response": response })
}

fn snapshot_step(label: &str, runtime_view: &Value) -> Value {
    json!({ "kind": "transcript_snapshot", "label": label, "runtimeView": runtime_view })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_scenario_replays_against_the_fake_omp_tape() {
    // --- Fixture wiring: PATH-shim the fake `omp`, point it at the `session` scenario tape. ---
    let shim_dir = std::env::temp_dir().join(format!(
        "refract-contract-replay-shim-{}",
        uuid::Uuid::new_v4()
    ));
    build_omp_shim(&shim_dir);
    let fake_omp_script = repo_root()
        .join("scripts")
        .join("verify-tauri-fake-omp.mjs");
    assert!(
        fake_omp_script.is_file(),
        "contract_replay: expected fake-omp script at {}",
        fake_omp_script.display()
    );
    let existing_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{};{existing_path}", shim_dir.display());
    // Safety: this is the first line of this test, before any child process is spawned and
    // before `process::executables::resolve_omp()`'s own cache can have been primed by anything
    // else in this process -- no other code path reads/writes `PATH`/these two vars
    // concurrently (mirrors `process::executables::ensure_no_default_cwd_in_exe_path`'s own
    // `unsafe` `set_var` justification).
    unsafe {
        std::env::set_var("PATH", &new_path);
        std::env::set_var("REFRACT_FAKE_OMP_SCRIPT", &fake_omp_script);
        std::env::set_var("REFRACT_FAKE_OMP_NODE", "node");
        std::env::set_var("REFRACT_FAKE_OMP_SCENARIO", "session");
    }

    // --- AppState / Dispatcher, same construction recipe as this crate's own handler tests. ---
    let data_dir = std::env::temp_dir().join(format!(
        "refract-contract-replay-data-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&data_dir).expect("create scratch data dir");
    let state = make_state(&data_dir).await;
    let mut dispatcher = Dispatcher::new();
    register_handlers(&mut dispatcher);

    let repo_dir = make_scratch_repo();

    let mut steps: Vec<Value> = Vec::new();

    // 1. repositories.add
    let add_args = json!(repo_dir.to_string_lossy());
    let add_envelope = dispatcher
        .dispatch("repositories.add", state.clone(), vec![add_args.clone()])
        .await;
    assert_eq!(add_envelope.get("ok"), Some(&Value::Bool(true)), "{add_envelope:?}");
    let repository = add_envelope["value"].clone();
    let repo_id = repository["id"].as_str().expect("repository.id").to_string();
    let repo_path = repository["path"].as_str().expect("repository.path").to_string();
    let repo_name = repository["name"].as_str().expect("repository.name").to_string();
    steps.push(ipc_step("repositories.add", &add_args, &add_envelope));

    // 2. sessions.create
    let create_args = json!([{ "repositoryId": repo_id, "baseBranch": "main" }]);
    let create_envelope = dispatcher
        .dispatch(
            "sessions.create",
            state.clone(),
            vec![create_args[0].clone()],
        )
        .await;
    assert_eq!(create_envelope.get("ok"), Some(&Value::Bool(true)), "{create_envelope:?}");
    let session = create_envelope["value"].clone();
    let session_id = session["id"].as_str().expect("session.id").to_string();
    let worktree_path = session["worktreePath"]
        .as_str()
        .expect("session.worktreePath")
        .to_string();
    let branch_name = session["branch"].as_str().expect("session.branch").to_string();
    steps.push(ipc_step("sessions.create", &create_args, &create_envelope));

    let agent = state.session_manager.get_or_create_agent(&session_id);

    // 3. sessions.open: spawns the shimmed `omp`, drives negotiate_protocol/get_state/
    //    available_commands_update/get_messages_page (tape lines 1-8) to completion.
    let open_args = json!([session_id, true]);
    let open_envelope = dispatcher
        .dispatch("sessions.open", state.clone(), vec![
            Value::String(session_id.clone()),
            Value::Bool(true),
        ])
        .await;
    assert_eq!(open_envelope.get("ok"), Some(&Value::Bool(true)), "{open_envelope:?}");
    steps.push(ipc_step("sessions.open", &open_args, &open_envelope));
    steps.push(snapshot_step(
        "after_sessions_open",
        &agent.runtime_view().await,
    ));

    // 4. chat.send: the one-tool-call turn (tape's `prompt` wait/ack, then the async frame
    //    stream: agent_start, message_start/end, tool_execution_start, extension_ui_request).
    let send_args = json!([session_id, PROMPT_MESSAGE]);
    let send_envelope = dispatcher
        .dispatch(
            "chat.send",
            state.clone(),
            vec![
                Value::String(session_id.clone()),
                Value::String(PROMPT_MESSAGE.to_string()),
            ],
        )
        .await;
    assert_eq!(send_envelope.get("ok"), Some(&Value::Bool(true)), "{send_envelope:?}");
    steps.push(ipc_step("chat.send", &send_args, &send_envelope));

    wait_for_status(&agent, SessionStatus::NeedsYou, Duration::from_secs(10)).await;
    let after_request = agent.runtime_view().await;
    let request_id = after_request["pending"][0]["requestId"]
        .as_str()
        .expect("a pending approval request id")
        .to_string();
    steps.push(snapshot_step("after_approval_request", &after_request));

    // 5. chat.answer: approves the `write` tool call, sending `extension_ui_response` (tape's
    //    wait on that command); the tape then streams the assistant's reply and settles.
    let answer_args = json!([session_id, request_id, { "approve": true }]);
    let answer_envelope = dispatcher
        .dispatch(
            "chat.answer",
            state.clone(),
            vec![
                Value::String(session_id.clone()),
                Value::String(request_id.clone()),
                json!({ "approve": true }),
            ],
        )
        .await;
    assert_eq!(answer_envelope.get("ok"), Some(&Value::Bool(true)), "{answer_envelope:?}");
    steps.push(ipc_step("chat.answer", &answer_args, &answer_envelope));

    // The fixture's own `{"__delay__": 2000}` sits between the assistant's two streamed deltas
    // (scripts/fixtures/omp-frames/README.md's Provenance table), so settling takes a little
    // over two seconds; comfortably inside this bound without being anywhere near it, on every
    // run, deterministically (the tape never races against anything else).
    wait_for_status(&agent, SessionStatus::Idle, Duration::from_secs(15)).await;
    steps.push(snapshot_step(
        "after_turn_settled",
        &agent.runtime_view().await,
    ));

    agent.shutdown().await;

    // --- Normalize and compare against the frozen golden trace. ---
    let mut dynamic: Vec<(String, &'static str)> = vec![
        (worktree_path, "<WORKTREE_PATH>"),
        (repo_path, "<REPO_DIR>"),
        (repo_name, "<REPO_NAME>"),
        (branch_name, "<BRANCH_NAME>"),
        (session_id, "<SESSION_ID>"),
        (repo_id, "<REPO_ID>"),
    ];
    dynamic.sort_by_key(|(needle, _)| std::cmp::Reverse(needle.len()));

    let mut trace = Value::Array(steps);
    normalize(&mut trace, &dynamic);

    let pretty = serde_json::to_string_pretty(&trace).expect("trace is always JSON-serialisable");
    println!("contract_replay: normalized trace:\n{pretty}");

    let golden_path = repo_root()
        .join("scripts")
        .join("fixtures")
        .join("contract-replay")
        .join("session-scenario.rust-trace.json");
    let golden_text = std::fs::read_to_string(&golden_path).unwrap_or_else(|err| {
        panic!(
            "contract_replay: could not read golden file {} ({err}). \
             First run: copy the \"normalized trace\" block printed above (cargo test --test \
             contract_replay -- --nocapture) into that file after eyeballing it against \
             scripts/fixtures/omp-frames/session.jsonl, then re-run this test.",
            golden_path.display()
        )
    });
    let golden: Value = serde_json::from_str(&golden_text).unwrap_or_else(|err| {
        panic!(
            "contract_replay: golden file {} is not valid JSON: {err}",
            golden_path.display()
        )
    });

    assert_eq!(
        trace, golden,
        "contract_replay: captured trace no longer matches the frozen golden file at {}",
        golden_path.display()
    );
}
