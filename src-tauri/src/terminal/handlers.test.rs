// The `terminal.*` channels through the dispatcher, plus the manager rules T021 adds (tab limit, names).
// Shell-starting tests spawn a real `%COMSPEC%`/PowerShell (no mocks) and end the tree before returning.

use std::path::PathBuf;
use std::sync::Mutex as StdMutex;

use super::*;
use crate::events::EventSink;
use crate::session::SessionManager;
use crate::store::registry::{RegistryStore, Repository, Session};
use crate::store::session_kind::SessionKind;
use crate::store::settings::SettingsStore;
use crate::terminal::limits::MAX_TABS_PER_SESSION;
use crate::terminal::tab::TabState;
use crate::terminal::TerminalManager;
use tokio::sync::Mutex as AsyncMutex;

async fn make_state(label: &str) -> (AppState, PathBuf) {
    let dir = crate::test_scratch::path(format!(
        "refract-terminal-handlers-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let registry = RegistryStore::open(&dir).await.expect("open registry");
    let settings = SettingsStore::open(&dir).await.expect("open settings");
    let registry = Arc::new(AsyncMutex::new(registry));
    let settings = Arc::new(AsyncMutex::new(settings));
    let slot: Arc<StdMutex<Option<tauri::AppHandle>>> = Arc::new(StdMutex::new(None));
    let events = EventSink::new(slot.clone(), registry.clone());
    let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
    let state = AppState {
        data_dir: dir.clone(),
        registry,
        settings,
        app_handle: slot,
        session_manager,
    };
    (state, dir)
}

/// Registers a Project Session whose worktree is `worktree`.
async fn add_session(state: &AppState, id: &str, worktree: &std::path::Path) {
    let repo = crate::git::test_support::init_repo().await;
    let mut registry = state.registry.lock().await;
    registry
        .add_repository(Repository {
            id: "repo-1".to_string(),
            path: repo.to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
            color: None,
        })
        .await
        .expect("add_repository");
    registry
        .add_session(Session {
            id: id.to_string(),
            kind: SessionKind::Project,
            repository_id: Some("repo-1".to_string()),
            name: "terminal session".to_string(),
            branch: Some("feat/terminal".to_string()),
            base_branch: Some("main".to_string()),
            worktree_path: Some(worktree.to_string_lossy().into_owned()),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_activity_at: "2026-01-01T00:00:00.000Z".to_string(),
            archived_at: None,
            hidden_at: None,
            paused_held: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
            pinned_model: false,
            origin_issue: None,
            parent_session_id: None,
        })
        .await
        .expect("add_session");
}

fn dispatcher() -> Dispatcher {
    let mut dispatcher = Dispatcher::new();
    register(&mut dispatcher);
    dispatcher
}

fn error_code(envelope: &Value) -> &str {
    assert_eq!(envelope["ok"], false, "expected an error: {envelope}");
    envelope["error"]["code"].as_str().expect("error code")
}

fn end_shell(tab_id: &str) {
    if let Some(tab) = manager().find(tab_id) {
        tab.terminate();
    }
}

fn quiet() -> StateNotifier {
    Arc::new(|_: &TabInfo| {})
}

fn failed_start(tab: &Arc<Tab>) {
    tab.start_with(None, 80, 24);
}

#[tokio::test]
async fn every_terminal_channel_is_registered() {
    let (state, _dir) = make_state("registered").await;
    let dispatcher = dispatcher();
    for channel in [
        "terminal.list",
        "terminal.create",
        "terminal.attach",
        "terminal.detach",
        "terminal.input",
        "terminal.resize",
        "terminal.ack",
        "terminal.rename",
    ] {
        let envelope = dispatcher.dispatch(channel, state.clone(), vec![]).await;
        assert_eq!(error_code(&envelope), "invalid-argument", "{channel}");
    }
}

#[tokio::test]
async fn a_missing_session_is_terminal_not_found_for_list_and_create() {
    let (state, _dir) = make_state("missing").await;
    let dispatcher = dispatcher();

    let listed = dispatcher
        .dispatch("terminal.list", state.clone(), vec![json!("nope")])
        .await;
    let created = dispatcher
        .dispatch(
            "terminal.create",
            state,
            vec![json!("nope"), json!(80), json!(24)],
        )
        .await;

    assert_eq!(error_code(&listed), "terminal-not-found");
    assert_eq!(error_code(&created), "terminal-not-found");
}

#[tokio::test]
async fn create_starts_a_shell_in_the_session_folder_and_list_returns_it() {
    let (state, dir) = make_state("create").await;
    let worktree = dir.join("worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    add_session(&state, "session-create", &worktree).await;
    let dispatcher = dispatcher();

    let created = dispatcher
        .dispatch(
            "terminal.create",
            state.clone(),
            vec![json!("session-create"), json!(100), json!(30)],
        )
        .await;
    let tab = &created["value"];
    let tab_id = tab["id"].as_str().expect("tab id").to_string();

    assert_eq!(created["ok"], true, "{created}");
    assert_eq!(tab["name"], "Terminal 1");
    assert_eq!(tab["sessionId"], "session-create");
    assert_eq!(tab["cwd"], worktree.to_string_lossy().as_ref());
    assert_eq!(tab["state"]["kind"], "running");
    assert_eq!(tab["order"], 0);

    let listed = dispatcher
        .dispatch("terminal.list", state, vec![json!("session-create")])
        .await;
    assert_eq!(listed["value"]["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["value"]["tabs"][0]["id"], tab["id"]);
    assert_eq!(listed["value"]["activeTabId"], tab["id"]);
    end_shell(&tab_id);
}

#[tokio::test]
async fn resize_ack_detach_and_rename_work_on_a_live_tab_and_ignore_unknown_tabs() {
    let (state, dir) = make_state("live").await;
    add_session(&state, "session-live", &dir).await;
    let dispatcher = dispatcher();
    let created = dispatcher
        .dispatch(
            "terminal.create",
            state.clone(),
            vec![json!("session-live"), json!(80), json!(24)],
        )
        .await;
    let tab_id = created["value"]["id"].as_str().unwrap().to_string();

    // Out-of-range sizes are clamped, not rejected.
    let resized = dispatcher
        .dispatch(
            "terminal.resize",
            state.clone(),
            vec![json!(tab_id), json!(100_000), json!(0)],
        )
        .await;
    assert_eq!(resized, json!({ "ok": true, "value": null }));
    assert_eq!(manager().find(&tab_id).unwrap().size(), (500, 1));

    for (channel, args) in [
        ("terminal.ack", vec![json!(tab_id), json!(4096)]),
        ("terminal.detach", vec![json!(tab_id)]),
        ("terminal.ack", vec![json!("gone"), json!(1)]),
        ("terminal.detach", vec![json!("gone")]),
        ("terminal.resize", vec![json!("gone"), json!(80), json!(24)]),
    ] {
        let envelope = dispatcher.dispatch(channel, state.clone(), args).await;
        assert_eq!(envelope, json!({ "ok": true, "value": null }), "{channel}");
    }

    let renamed = dispatcher
        .dispatch(
            "terminal.rename",
            state.clone(),
            vec![json!(tab_id), json!("  build  ")],
        )
        .await;
    assert_eq!(renamed["value"]["name"], "build");
    let too_long = "x".repeat(41);
    for bad in ["   ", too_long.as_str()] {
        let refused = dispatcher
            .dispatch(
                "terminal.rename",
                state.clone(),
                vec![json!(tab_id), json!(bad)],
            )
            .await;
        assert_eq!(error_code(&refused), "invalid-argument");
    }
    let unknown = dispatcher
        .dispatch("terminal.rename", state, vec![json!("gone"), json!("name")])
        .await;
    assert_eq!(error_code(&unknown), "terminal-not-found");
    end_shell(&tab_id);
}

#[tokio::test]
async fn input_to_an_unknown_tab_is_terminal_not_found() {
    let (state, _dir) = make_state("input-unknown").await;

    let envelope = dispatcher()
        .dispatch(
            "terminal.input",
            state,
            vec![json!("gone"), json!("echo hi\r")],
        )
        .await;

    assert_eq!(error_code(&envelope), "terminal-not-found");
}

#[tokio::test]
async fn attach_validates_the_tab_the_session_and_the_channel() {
    let (state, dir) = make_state("attach").await;
    add_session(&state, "session-attach", &dir).await;
    let dispatcher = dispatcher();
    let created = dispatcher
        .dispatch(
            "terminal.create",
            state.clone(),
            vec![json!("session-attach"), json!(80), json!(24)],
        )
        .await;
    let tab_id = created["value"]["id"].as_str().unwrap().to_string();
    let attach = |session: &str, tab: &str, channel: &str| {
        dispatcher.dispatch(
            "terminal.attach",
            state.clone(),
            vec![
                json!(session),
                json!(tab),
                json!(channel),
                json!(80),
                json!(24),
            ],
        )
    };

    let unknown_tab = attach("session-attach", "gone", "__CHANNEL__:1").await;
    let other_session = attach("session-other", &tab_id, "__CHANNEL__:1").await;
    let bad_channel = attach("session-attach", &tab_id, "not a channel").await;
    // A well-formed handle with no window to deliver through cannot be attached.
    let no_window = attach("session-attach", &tab_id, "__CHANNEL__:1").await;

    assert_eq!(error_code(&unknown_tab), "terminal-not-found");
    assert_eq!(error_code(&other_session), "terminal-not-found");
    assert_eq!(error_code(&bad_channel), "invalid-argument");
    assert_eq!(error_code(&no_window), "terminal-not-running");
    end_shell(&tab_id);
}

#[test]
fn the_tab_state_event_names_the_session_and_tab_and_carries_no_output() {
    let manager = TerminalManager::default();
    let info = manager
        .create("session-event", PathBuf::from("."), quiet(), failed_start)
        .unwrap();

    let payload = tab_state_payload(&info);

    assert_eq!(payload["sessionId"], "session-event");
    assert_eq!(payload["tab"]["id"], info.id.as_str());
    assert_eq!(payload["tab"]["state"]["kind"], "failed");
    assert_eq!(
        payload.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["sessionId", "tab"]
    );
}

#[test]
fn a_session_holds_at_most_the_maximum_and_the_message_names_it() {
    let manager = TerminalManager::default();
    for _ in 0..MAX_TABS_PER_SESSION {
        manager
            .create("session-full", PathBuf::from("."), quiet(), failed_start)
            .unwrap();
    }

    let refused = manager
        .create("session-full", PathBuf::from("."), quiet(), failed_start)
        .unwrap_err();
    let other_session = manager.create("session-free", PathBuf::from("."), quiet(), failed_start);

    assert_eq!(refused.code, "terminal-limit");
    assert!(refused.message.contains(&MAX_TABS_PER_SESSION.to_string()));
    assert!(other_session.is_ok());
    assert_eq!(manager.list("session-full").0.len(), MAX_TABS_PER_SESSION);
}

#[test]
fn tabs_are_named_with_the_lowest_unused_number_and_ordered_as_created() {
    let manager = TerminalManager::default();
    let create = || {
        manager
            .create("session-names", PathBuf::from("."), quiet(), failed_start)
            .unwrap()
    };
    let first = create();
    let second = create();
    let third = create();

    // Renaming frees a number; the next tab takes the lowest one that is free.
    manager.find(&second.id).unwrap().rename("build").unwrap();
    let fourth = create();

    let names: Vec<_> = [&first, &second, &third, &fourth]
        .iter()
        .map(|info| info.name.clone())
        .collect();
    assert_eq!(
        names,
        ["Terminal 1", "Terminal 2", "Terminal 3", "Terminal 2"]
    );
    let (tabs, active) = manager.list("session-names");
    assert_eq!(
        tabs.iter().map(|tab| tab.order).collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert_eq!(active.as_deref(), Some(fourth.id.as_str()));
}

#[test]
fn list_reports_the_last_shown_tab_and_falls_back_to_the_first() {
    let manager = TerminalManager::default();
    assert_eq!(manager.list("session-active"), (vec![], None));
    let first = manager
        .create("session-active", PathBuf::from("."), quiet(), failed_start)
        .unwrap();
    manager
        .create("session-active", PathBuf::from("."), quiet(), failed_start)
        .unwrap();

    manager.set_active("session-active", &first.id);
    assert_eq!(
        manager.list("session-active").1.as_deref(),
        Some(first.id.as_str())
    );

    manager.set_active("session-active", "gone");
    assert_eq!(
        manager.list("session-active").1.as_deref(),
        Some(first.id.as_str())
    );
}

#[test]
fn a_failed_tab_still_counts_and_reports_its_state() {
    let manager = TerminalManager::default();

    let info = manager
        .create("session-failed", PathBuf::from("."), quiet(), failed_start)
        .unwrap();

    assert!(matches!(info.state, TabState::Failed { .. }));
    assert_eq!(manager.list("session-failed").0.len(), 1);
}
