// What survives a relaunch: tab identity only, repaired on the way in, never any terminal content.

use std::collections::{BTreeMap, HashSet};

use super::*;

fn scratch(label: &str) -> PathBuf {
    let dir = crate::test_scratch::path(format!(
        "refract-terminal-persist-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn tab(id: &str, name: &str, order: u32) -> SavedTab {
    SavedTab {
        id: id.to_string(),
        name: name.to_string(),
        cwd: "C:/work/app".to_string(),
        shell: "pwsh".to_string(),
        order,
    }
}

fn session(tabs: Vec<SavedTab>, active: Option<&str>) -> SavedSession {
    SavedSession {
        active_tab_id: active.map(str::to_string),
        tabs,
    }
}

fn known(ids: &[&str]) -> HashSet<String> {
    ids.iter().map(|id| id.to_string()).collect()
}

fn live_of(entries: Vec<(&str, SavedSession)>) -> BTreeMap<String, SavedSession> {
    entries
        .into_iter()
        .map(|(id, saved)| (id.to_string(), saved))
        .collect()
}

#[tokio::test]
async fn saved_tabs_load_back_in_order_with_the_active_tab() {
    let dir = scratch("roundtrip");
    let saved = session(vec![tab("b", "Build", 1), tab("a", "Server", 0)], Some("b"));

    save_live(&dir, || live_of(vec![("s1", saved)])).await;
    let loaded = load(&dir, &known(&["s1"])).await;

    let record = &loaded.sessions["s1"];
    assert_eq!(record.active_tab_id.as_deref(), Some("b"));
    let names: Vec<&str> = record.tabs.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["Server", "Build"]);
    assert_eq!(record.tabs[0].cwd, "C:/work/app");
    assert_eq!(record.tabs[0].shell, "pwsh");
}

#[tokio::test]
async fn the_file_holds_identity_only() {
    let dir = scratch("identity-only");

    save_live(&dir, || {
        live_of(vec![("s1", session(vec![tab("a", "Shell", 0)], None))])
    })
    .await;

    let raw = std::fs::read_to_string(file_path(&dir)).expect("file written");
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let keys: Vec<&String> = value["sessions"]["s1"]["tabs"][0]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(keys, ["cwd", "id", "name", "order", "shell"]);
}

#[tokio::test]
async fn a_missing_file_loads_as_no_tabs() {
    let dir = scratch("missing");

    let loaded = load(&dir, &known(&["s1"])).await;

    assert!(loaded.sessions.is_empty());
}

#[tokio::test]
async fn a_corrupt_file_loads_as_no_tabs_and_is_set_aside() {
    let dir = scratch("corrupt");
    std::fs::write(file_path(&dir), "{ not json").unwrap();

    let loaded = load(&dir, &known(&["s1"])).await;

    assert!(loaded.sessions.is_empty());
    assert!(!file_path(&dir).exists(), "the broken file is quarantined");
}

#[tokio::test]
async fn load_repairs_what_a_hand_edited_file_got_wrong() {
    let dir = scratch("repair");
    let many: Vec<serde_json::Value> = (0..10)
        .map(|n| {
            serde_json::json!({
                "id": format!("t{n}"), "name": "x", "cwd": "C:/w", "shell": "pwsh", "order": n
            })
        })
        .collect();
    let file = serde_json::json!({
        "version": 1,
        "sessions": {
            "s1": { "activeTabId": "t0", "tabs": many },
            "s2": { "activeTabId": "gone", "tabs": [
                { "id": "odd", "name": format!("  {}  ", "n".repeat(60)), "cwd": "C:/w", "shell": "zsh", "order": 0 },
                { "id": "odd", "name": "duplicate id", "cwd": "C:/w", "shell": "cmd", "order": 1 },
                { "id": "", "name": "no id", "cwd": "C:/w", "shell": "cmd", "order": 2 },
                { "id": "blank", "name": "   ", "cwd": "C:/w", "shell": "cmd", "order": 3 }
            ] },
            "deleted": { "tabs": [ { "id": "z", "name": "z", "cwd": "C:/w", "shell": "cmd", "order": 0 } ] }
        }
    });
    std::fs::write(file_path(&dir), file.to_string()).unwrap();

    let loaded = load(&dir, &known(&["s1", "s2"])).await;

    assert_eq!(
        loaded.sessions.len(),
        2,
        "a Session that no longer exists is dropped"
    );
    assert_eq!(loaded.sessions["s1"].tabs.len(), MAX_TABS_PER_SESSION);
    let second = &loaded.sessions["s2"];
    assert_eq!(second.tabs.len(), 2);
    assert_eq!(
        second.tabs[0].shell, "powershell",
        "an unknown shell becomes powershell"
    );
    assert_eq!(second.tabs[0].name.chars().count(), NAME_MAX_CHARS);
    assert_eq!(
        second.tabs[1].name, "Terminal 2",
        "a blank name gets its default"
    );
    assert_eq!(
        second.active_tab_id, None,
        "an active tab that is gone is forgotten"
    );
}

#[tokio::test]
async fn a_file_of_an_unknown_version_is_ignored() {
    let dir = scratch("version");
    std::fs::write(
        file_path(&dir),
        r#"{"version":99,"sessions":{"s1":{"tabs":[{"id":"a","name":"A","cwd":"C:/w","shell":"cmd","order":0}]}}}"#,
    )
    .unwrap();

    let loaded = load(&dir, &known(&["s1"])).await;

    assert!(loaded.sessions.is_empty());
}

#[tokio::test]
async fn saving_one_session_leaves_the_others_and_an_emptied_one_loses_its_record() {
    let dir = scratch("merge");
    save_live(&dir, || {
        live_of(vec![
            ("s1", session(vec![tab("a", "A", 0)], None)),
            ("s2", session(vec![tab("b", "B", 0)], None)),
        ])
    })
    .await;

    save_live(&dir, || {
        live_of(vec![("s1", session(vec![tab("c", "C", 0)], None))])
    })
    .await;
    let after_replace = load(&dir, &known(&["s1", "s2"])).await;
    save_live(&dir, || live_of(vec![("s1", session(vec![], None))])).await;
    let after_empty = load(&dir, &known(&["s1", "s2"])).await;

    assert_eq!(after_replace.sessions["s1"].tabs[0].id, "c");
    assert_eq!(after_replace.sessions["s2"].tabs[0].id, "b");
    assert!(!after_empty.sessions.contains_key("s1"));
    assert!(after_empty.sessions.contains_key("s2"));
}

#[tokio::test]
async fn forgetting_a_session_drops_only_its_record() {
    let dir = scratch("forget");
    save_live(&dir, || {
        live_of(vec![
            ("s1", session(vec![tab("a", "A", 0)], None)),
            ("s2", session(vec![tab("b", "B", 0)], None)),
        ])
    })
    .await;

    forget_session(&dir, "s1").await;
    forget_session(&dir, "never-saved").await;
    let loaded = load(&dir, &known(&["s1", "s2"])).await;

    assert!(!loaded.sessions.contains_key("s1"));
    assert!(loaded.sessions.contains_key("s2"));
}
