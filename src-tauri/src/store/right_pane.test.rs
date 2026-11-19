// Validation of the right pane row: the width ceiling and the #2075 document tabs.

use serde_json::{json, Map, Value};

use super::{
    default_state, parse, parse_from_disk, DiffGroup, DocumentKind, KEY, WIDTH_MAX, WIDTH_MIN,
};

fn row(extra: Value) -> Value {
    let mut base = json!({
        "open": true,
        "widthPx": 320,
        "openPanelIds": ["git-changes"],
        "activePanelId": "git-changes",
        "panelOrder": []
    });
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn session_tabs(tabs: Value) -> Value {
    json!({ "documentTabs": { "s1": { "tabs": tabs, "activeId": null, "recency": [] } } })
}

#[test]
fn a_row_without_the_new_keys_has_no_tabs_and_chat_shown() {
    let state = parse(&row(json!({}))).expect("valid row");
    assert!(state.document_tabs.is_empty());
    assert!(!state.chat_collapsed);
}

#[test]
fn a_missing_right_pane_key_is_the_default() {
    assert_eq!(parse_from_disk(&Map::new()), default_state());
}

#[test]
fn width_clamps_to_the_floor_and_the_sanity_ceiling() {
    let wide = parse(&row(json!({ "widthPx": 99_999 }))).expect("valid row");
    assert_eq!(wide.width_px, WIDTH_MAX);
    assert_eq!(WIDTH_MAX, 4096);
    let narrow = parse(&row(json!({ "widthPx": 1 }))).expect("valid row");
    assert_eq!(narrow.width_px, WIDTH_MIN);
    let beyond_old_cap = parse(&row(json!({ "widthPx": 900 }))).expect("valid row");
    assert_eq!(beyond_old_cap.width_px, 900);
}

#[test]
fn chat_collapsed_round_trips_and_a_bad_type_is_ignored() {
    let on = parse(&row(json!({ "chatCollapsed": true }))).expect("valid row");
    assert!(on.chat_collapsed);
    let bad = parse(&row(json!({ "chatCollapsed": "yes" }))).expect("valid row");
    assert!(!bad.chat_collapsed);
}

#[test]
fn a_bad_document_tabs_shape_is_ignored_not_fatal() {
    for shape in [json!([]), json!("x"), json!(7), Value::Null] {
        let state = parse(&row(json!({ "documentTabs": shape }))).expect("valid row");
        assert!(state.document_tabs.is_empty());
    }
    let entry_not_object = parse(&row(json!({ "documentTabs": { "s1": 3 } }))).expect("valid row");
    assert!(entry_not_object.document_tabs.is_empty());
}

#[test]
fn valid_file_and_diff_tabs_are_kept_with_their_active_id_and_recency() {
    let state = parse(&row(json!({ "documentTabs": { "s1": {
        "tabs": [
            { "kind": "file", "path": "src/a.ts" },
            { "kind": "diff", "group": "staged", "path": "src/a.ts" }
        ],
        "activeId": "diff:staged:src/a.ts",
        "recency": ["file:src/a.ts", "diff:staged:src/a.ts", "file:gone.ts"]
    } } })))
    .expect("valid row");
    let session = &state.document_tabs["s1"];
    assert_eq!(session.tabs.len(), 2);
    assert_eq!(session.tabs[1].kind, DocumentKind::Diff);
    assert_eq!(session.tabs[1].group, Some(DiffGroup::Staged));
    assert_eq!(session.active_id.as_deref(), Some("diff:staged:src/a.ts"));
    assert_eq!(session.recency, ["file:src/a.ts", "diff:staged:src/a.ts"]);
}

#[test]
fn tabs_with_a_bad_kind_group_or_kind_group_pairing_are_dropped() {
    let state = parse(&row(session_tabs(json!([
        { "kind": "file", "path": "ok.ts" },
        { "kind": "image", "path": "x.png" },
        { "kind": "diff", "group": "nope", "path": "x.ts" },
        { "kind": "diff", "path": "no-group.ts" },
        { "kind": "file", "group": "staged", "path": "file-with-group.ts" }
    ]))))
    .expect("valid row");
    let tabs = &state.document_tabs["s1"].tabs;
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].path, "ok.ts");
}

#[test]
fn tabs_with_a_non_relative_path_are_dropped() {
    let bad = [
        "",
        "/etc/passwd",
        "C:/Windows/x",
        "c:x",
        "a/../b",
        "./a",
        "a//b",
        "a\\b",
        "a\0b",
    ];
    let mut tabs = vec![json!({ "kind": "file", "path": "keep.ts" })];
    tabs.extend(
        bad.iter()
            .map(|path| json!({ "kind": "file", "path": path })),
    );
    let state = parse(&row(session_tabs(Value::Array(tabs)))).expect("valid row");
    let kept: Vec<&str> = state.document_tabs["s1"]
        .tabs
        .iter()
        .map(|tab| tab.path.as_str())
        .collect();
    assert_eq!(kept, ["keep.ts"]);
}

#[test]
fn the_path_bound_is_1024_bytes_inclusive() {
    let at_limit = "a".repeat(1024);
    let over = "a".repeat(1025);
    let state = parse(&row(session_tabs(json!([
        { "kind": "file", "path": at_limit },
        { "kind": "file", "path": over }
    ]))))
    .expect("valid row");
    let tabs = &state.document_tabs["s1"].tabs;
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].path.len(), 1024);
}

#[test]
fn a_repeated_identity_is_kept_once() {
    let state = parse(&row(session_tabs(json!([
        { "kind": "file", "path": "a.ts" },
        { "kind": "file", "path": "a.ts" }
    ]))))
    .expect("valid row");
    assert_eq!(state.document_tabs["s1"].tabs.len(), 1);
}

#[test]
fn a_session_over_twenty_tabs_is_dropped_whole_and_twenty_is_kept() {
    let many = |count: usize| -> Value {
        Value::Array(
            (0..count)
                .map(|i| json!({ "kind": "file", "path": format!("f{i}.ts") }))
                .collect(),
        )
    };
    let over = parse(&row(session_tabs(many(21)))).expect("valid row");
    assert!(over.document_tabs.is_empty());
    let exact = parse(&row(session_tabs(many(20)))).expect("valid row");
    assert_eq!(exact.document_tabs["s1"].tabs.len(), 20);
}

#[test]
fn an_active_id_that_matches_no_tab_is_cleared() {
    let state = parse(&row(json!({ "documentTabs": { "s1": {
        "tabs": [{ "kind": "file", "path": "a.ts" }],
        "activeId": "file:other.ts",
        "recency": []
    } } })))
    .expect("valid row");
    assert_eq!(state.document_tabs["s1"].active_id, None);
}

#[test]
fn a_session_left_with_no_valid_tab_is_dropped() {
    let state = parse(&row(session_tabs(
        json!([{ "kind": "file", "path": "../x" }]),
    )))
    .expect("valid row");
    assert!(state.document_tabs.is_empty());
}

#[test]
fn an_oversized_session_key_is_dropped() {
    let key = "k".repeat(129);
    let state = parse(&row(json!({ "documentTabs": { key: {
        "tabs": [{ "kind": "file", "path": "a.ts" }],
        "activeId": null,
        "recency": []
    } } })))
    .expect("valid row");
    assert!(state.document_tabs.is_empty());
}

#[test]
fn the_state_serialises_back_to_the_camel_case_row_it_was_read_from() {
    let input = row(json!({
        "chatCollapsed": true,
        "documentTabs": { "s1": {
            "tabs": [
                { "kind": "file", "path": "a.ts" },
                { "kind": "diff", "group": "untracked", "path": "b.ts" }
            ],
            "activeId": "file:a.ts",
            "recency": ["diff:untracked:b.ts", "file:a.ts"]
        } }
    }));
    let state = parse(&input).expect("valid row");
    let written = serde_json::to_value(&state).expect("serialises");
    assert_eq!(parse(&written), Some(state));
    assert_eq!(
        written["documentTabs"]["s1"]["tabs"][0],
        json!({ "kind": "file", "path": "a.ts" })
    );
    assert_eq!(written["chatCollapsed"], json!(true));
    assert_eq!(KEY, "rightPane");
}
