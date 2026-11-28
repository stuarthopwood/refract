use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::terminal::tab::TabState;

fn quiet() -> StateNotifier {
    Arc::new(|_: &TabInfo| {})
}

/// Starts nothing real: the tab ends up `failed`, which is enough to exercise the bookkeeping.
fn failed_start(tab: &Arc<Tab>) {
    tab.start_with(None, 80, 24);
}

fn saved_tab(id: &str, name: &str, order: u32, shell: &str) -> SavedTab {
    SavedTab {
        id: id.to_string(),
        name: name.to_string(),
        cwd: "C:/work".to_string(),
        shell: shell.to_string(),
        order,
    }
}

#[test]
fn manager_is_one_shared_instance() {
    assert!(std::ptr::eq(manager(), manager()));
}

#[test]
fn lifecycle_hooks_are_safe_with_no_tabs() {
    // A private manager: the shared one carries other tests' live shells.
    let manager = TerminalManager::default();
    manager.close_session("no-such-session");
    manager.shutdown_all();
}

#[test]
fn closing_a_tab_removes_it_and_forgets_it_as_the_active_tab() {
    let manager = TerminalManager::default();
    let first = manager
        .create("s", PathBuf::from("."), quiet(), failed_start)
        .unwrap();
    let second = manager
        .create("s", PathBuf::from("."), quiet(), failed_start)
        .unwrap();

    let outcome = manager.close(&second.id, false);

    assert_eq!(outcome, CloseOutcome::Closed);
    let (tabs, active) = manager.list("s");
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].id, first.id);
    assert_eq!(active.as_deref(), Some(first.id.as_str()));
    assert!(manager.find(&second.id).is_none());
}

#[test]
fn closing_a_tab_that_is_already_gone_is_not_an_error() {
    let manager = TerminalManager::default();

    assert_eq!(manager.close("gone", false), CloseOutcome::Closed);
    assert_eq!(manager.close("gone", true), CloseOutcome::Closed);
}

#[test]
fn a_closed_tab_does_not_announce_its_shell_ending() {
    let notices = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&notices);
    let notify: StateNotifier = Arc::new(move |_: &TabInfo| {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let manager = TerminalManager::default();
    let info = manager
        .create("s", PathBuf::from("."), notify, |_| {})
        .unwrap();
    let tab = manager.find(&info.id).unwrap();

    manager.close(&info.id, true);
    tab.start_with(None, 80, 24);

    assert!(matches!(tab.state(), TabState::Failed { .. }));
    assert_eq!(notices.load(Ordering::SeqCst), 0);
}

#[test]
fn closing_a_session_ends_every_tab_and_blocks_a_later_restore() {
    let manager = TerminalManager::default();
    manager
        .create("gone", PathBuf::from("."), quiet(), failed_start)
        .unwrap();
    manager
        .create("kept", PathBuf::from("."), quiet(), failed_start)
        .unwrap();

    manager.close_session("gone");

    assert!(manager.list("gone").0.is_empty());
    assert_eq!(manager.list("kept").0.len(), 1);
    assert!(
        !manager.claim_restore("gone"),
        "an archived Session's terminals are never revived"
    );
    assert!(!manager.saved_sessions().contains_key("gone"));
}

#[test]
fn shutting_down_ends_every_tab_of_every_session() {
    let manager = TerminalManager::default();
    for session in ["a", "b"] {
        manager
            .create(session, PathBuf::from("."), quiet(), failed_start)
            .unwrap();
    }

    manager.shutdown_all();

    assert!(manager.list("a").0.is_empty());
    assert!(manager.list("b").0.is_empty());
}

#[test]
fn restore_runs_once_per_session() {
    let manager = TerminalManager::default();

    assert!(manager.claim_restore("s"));
    assert!(!manager.claim_restore("s"));
    assert!(manager.claim_restore("other"));
}

#[test]
fn restore_starts_fresh_shells_for_the_saved_tabs_in_their_saved_places() {
    let manager = TerminalManager::default();
    let saved = SavedSession {
        active_tab_id: Some("b".to_string()),
        tabs: vec![
            saved_tab("a", "Server", 0, "cmd"),
            saved_tab("b", "Build", 1, "no-such-shell"),
        ],
    };

    manager.restore("s", &saved, &quiet(), failed_start);

    let (tabs, active) = manager.list("s");
    let summary: Vec<(&str, &str, ShellKind)> = tabs
        .iter()
        .map(|t| (t.id.as_str(), t.name.as_str(), t.shell))
        .collect();
    assert_eq!(
        summary,
        [
            ("a", "Server", ShellKind::Cmd),
            ("b", "Build", ShellKind::Powershell)
        ]
    );
    assert_eq!(tabs[0].cwd, "C:/work");
    assert_eq!(active.as_deref(), Some("b"));
    assert!(matches!(tabs[0].state, TabState::Failed { .. }));
}

#[test]
fn restore_respects_the_tab_limit_and_skips_ids_already_in_use() {
    let manager = TerminalManager::default();
    let many: Vec<SavedTab> = (0..12)
        .map(|n| saved_tab(&format!("t{n}"), "x", n, "cmd"))
        .collect();
    let saved = SavedSession {
        active_tab_id: None,
        tabs: many,
    };
    manager.restore("s", &saved, &quiet(), failed_start);
    manager.restore("other", &saved, &quiet(), failed_start);

    assert_eq!(manager.list("s").0.len(), MAX_TABS_PER_SESSION);
    let other: Vec<String> = manager.list("other").0.into_iter().map(|t| t.id).collect();
    assert_eq!(
        other,
        ["t8", "t9", "t10", "t11"],
        "ids held by another Session are skipped; the rest fit"
    );
}

#[test]
fn saved_sessions_reports_tab_identity_in_order_and_skips_sessions_not_yet_restored() {
    let manager = TerminalManager::default();
    let first = manager
        .create("s", PathBuf::from("C:/work"), quiet(), failed_start)
        .unwrap();
    let second = manager
        .create("s", PathBuf::from("C:/work"), quiet(), failed_start)
        .unwrap();
    manager.set_active("s", &second.id);
    manager.claim_restore("pending");

    let saved = manager.saved_sessions();

    assert!(!saved.contains_key("pending"));
    let record = &saved["s"];
    assert_eq!(record.active_tab_id.as_deref(), Some(second.id.as_str()));
    let ids: Vec<&str> = record.tabs.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, [first.id.as_str(), second.id.as_str()]);
    assert_eq!(record.tabs[0].shell, "powershell");
}

#[test]
fn a_session_whose_tabs_were_all_closed_reports_an_empty_list() {
    let manager = TerminalManager::default();
    let only = manager
        .create("s", PathBuf::from("."), quiet(), failed_start)
        .unwrap();

    manager.close(&only.id, true);

    assert!(manager.saved_sessions()["s"].tabs.is_empty());
}
