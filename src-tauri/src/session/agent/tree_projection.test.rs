// The tree projection and OMP failure mapping, without a process.

use serde_json::{json, Value};

use super::{project_tree, rpc_failure};

fn message(id: &str, role: &str, content: Value, children: Vec<Value>) -> Value {
    json!({
        "entry": { "type": "message", "id": id, "timestamp": "2026-11-27T10:00:00Z",
                   "message": { "role": role, "content": content } },
        "children": children,
    })
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
}
