// Unit tests for `is_chat_answer` (lane R4, issue #787; gate-fix round 2 -- pure, cheap to test
// now rather than deferring). Scoped to this one function only: the rest of `requests.rs`
// (dialog classification, `answer_request`'s own live-process path) belongs to the broader
// `session::agent` split, not this lane. `#[path]`-loaded sibling of `requests.rs` (excluded from
// `check:file-size` by its own `.test.rs` name).

use super::*;

#[test]
fn is_chat_answer_accepts_every_documented_shape() {
    assert!(is_chat_answer(&json!({ "approve": true })));
    assert!(is_chat_answer(&json!({ "approve": false })));
    assert!(is_chat_answer(&json!({ "value": "some text" })));
    assert!(is_chat_answer(&json!({ "value": "" })));
    assert!(is_chat_answer(&json!({ "confirmed": true })));
    assert!(is_chat_answer(&json!({ "confirmed": false })));
    assert!(is_chat_answer(&json!({ "cancelled": true })));
}

#[test]
fn is_chat_answer_rejects_non_objects() {
    assert!(!is_chat_answer(&Value::Null));
    assert!(!is_chat_answer(&json!("a string")));
    assert!(!is_chat_answer(&json!(42)));
    assert!(!is_chat_answer(&json!([true])));
}

#[test]
fn is_chat_answer_rejects_wrong_field_types() {
    assert!(!is_chat_answer(&json!({ "approve": "yes" })));
    assert!(!is_chat_answer(&json!({ "value": 123 })));
    assert!(!is_chat_answer(&json!({ "confirmed": "true" })));
    // `cancelled` is only ever meaningful as the literal `true`.
    assert!(!is_chat_answer(&json!({ "cancelled": false })));
    assert!(!is_chat_answer(&json!({ "cancelled": "true" })));
}

#[test]
fn is_chat_answer_rejects_an_object_with_none_of_the_recognised_fields() {
    assert!(!is_chat_answer(&json!({})));
    assert!(!is_chat_answer(&json!({ "somethingElse": true })));
}
