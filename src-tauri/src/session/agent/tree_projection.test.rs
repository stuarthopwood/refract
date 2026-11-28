// The tree projection and OMP failure mapping, without a process.

use serde_json::{json, Value};

use super::{project_tree, rpc_failure};

// `message` is a session-file entry type (the schema leaves tree nodes opaque), not a wire literal;
// routing it through `other` keeps the drift scanner from reading it as an undeclared `type:` tag.
fn message(id: &str, role: &str, content: Value, children: Vec<Value>) -> Value {
    let mut node = other("message", id, children);
    node["entry"]["timestamp"] = json!("2026-11-27T10:00:00Z");
    node["entry"]["message"] = json!({ "role": role, "content": content });
    node
}

fn other(kind: &str, id: &str, children: Vec<Value>) -> Value {
    json!({ "entry": { "type": kind, "id": id }, "children": children })
}

#[test]
fn drops_non_message_entries_and_reparents_to_the_nearest_message() {
    let tree = json!({
        "leafId": "l1",
        "tree": [other("model_change", "m0", vec![
            message("u1", "user", json!("hello"), vec![
                other("custom", "c1", vec![message("a1", "assistant", json!("hi"), vec![other("label", "l1", vec![])])]),
            ]),
        ])],
    });
    let out = project_tree(&tree);
    let entries = out["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["parentId"], Value::Null);
    assert_eq!(entries[1]["id"], "a1");
    assert_eq!(entries[1]["parentId"], "u1");
    assert_eq!(out["leafId"], "a1");
}

#[test]
fn keeps_sibling_branches_in_order_and_labels_only_when_non_empty() {
    let mut first = message("b1", "assistant", json!("one"), vec![]);
    first["label"] = json!("keep");
    let mut second = message("b2", "assistant", json!("two"), vec![]);
    second["label"] = json!("");
    let tree =
        json!({ "leafId": "b2", "tree": [message("u1", "user", json!("q"), vec![first, second])] });
    let out = project_tree(&tree);
    let ids: Vec<&str> = out["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["u1", "b1", "b2"]);
    assert_eq!(out["entries"][1]["label"], "keep");
    assert_eq!(out["entries"][2]["label"], Value::Null);
}

#[test]
fn previews_text_blocks_collapsed_and_capped() {
    let long = "x".repeat(500);
    let tree = json!({ "tree": [
        message("u1", "user", json!([{ "type": "text", "text": " a\n b " }, { "type": "image" }, { "type": "text", "text": "c" }]), vec![]),
        message("u2", "user", json!(long), vec![]),
    ] });
    let out = project_tree(&tree);
    assert_eq!(out["entries"][0]["text"], "a b c");
    assert_eq!(out["entries"][1]["text"].as_str().unwrap().len(), 200);
    assert_eq!(out["leafId"], Value::Null);
}

#[test]
fn the_preview_cap_counts_characters_not_bytes() {
    let emoji = "😀".repeat(300);
    let tree = json!({ "tree": [message("u1", "user", json!(emoji), vec![])] });
    let preview = project_tree(&tree)["entries"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(preview.chars().count(), 200);
    assert_eq!(preview, "😀".repeat(200));
}

#[test]
fn the_preview_stops_at_the_cap_across_blocks_without_a_trailing_space() {
    let block = format!("{} tail", "a".repeat(199));
    let content =
        json!([{ "type": "text", "text": block }, { "type": "text", "text": "never reached" }]);
    let tree = json!({ "tree": [message("u1", "user", content, vec![])] });
    let preview = project_tree(&tree)["entries"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(preview, "a".repeat(199));
}

#[test]
fn a_leaf_that_matches_no_node_projects_to_null() {
    let tree = json!({ "leafId": "ghost", "tree": [message("u1", "user", json!("q"), vec![])] });
    assert_eq!(project_tree(&tree)["leafId"], Value::Null);
}

#[test]
fn a_message_without_an_id_is_dropped_and_its_children_reparent_to_the_nearest_message() {
    let mut anonymous = message(
        "ignored",
        "assistant",
        json!("no id"),
        vec![message("u2", "user", json!("next"), vec![])],
    );
    anonymous["entry"].as_object_mut().unwrap().remove("id");
    let tree =
        json!({ "leafId": "u2", "tree": [message("u1", "user", json!("q"), vec![anonymous])] });
    let out = project_tree(&tree);
    let entries = out["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1]["id"], "u2");
    assert_eq!(entries[1]["parentId"], "u1");
    assert_eq!(out["leafId"], "u2");
}

#[test]
fn walks_a_long_conversation_in_order() {
    let mut node = message("m200", "assistant", json!("leaf"), vec![]);
    for i in (0..200).rev() {
        node = message(&format!("m{i}"), "user", json!("x"), vec![node]);
    }
    let out = project_tree(&json!({ "tree": [node], "leafId": "m200" }));
    let entries = out["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 201);
    assert_eq!(entries[0]["id"], "m0");
    assert_eq!(entries[200]["parentId"], "m199");
    assert_eq!(out["leafId"], "m200");
}

#[test]
fn maps_failure_frames_to_stable_codes() {
    let code = |frame: Value| rpc_failure(&frame).code;
    assert_eq!(
        code(json!({ "error": "busy", "code": "session_busy" })),
        "not-idle"
    );
    assert_eq!(
        code(json!({ "error": "x", "code": "entry_not_found" })),
        "entry-not-found"
    );
    assert_eq!(
        code(json!({ "error": "Entry nope not found" })),
        "entry-not-found"
    );
    assert_eq!(
        code(json!({ "error": "Invalid entry ID for forking: z" })),
        "entry-not-found"
    );
    assert_eq!(
        code(json!({ "error": "x", "code": "ask_reanswer_unsupported" })),
        "ask-reanswer-unsupported"
    );
    assert_eq!(code(json!({ "error": "boom" })), "tree-failed");
    assert_eq!(
        code(json!({ "error": "x", "code": "something_new" })),
        "tree-failed"
    );
    assert_eq!(rpc_failure(&json!({})).message, "unknown error");
    // Only OMP's own entry-id messages count; other "not found" text is an ordinary failure.
    for other in [
        "Model not found",
        "Entry x not found in the index",
        "Session file not found",
    ] {
        assert_eq!(code(json!({ "error": other })), "tree-failed", "{other}");
    }
}
