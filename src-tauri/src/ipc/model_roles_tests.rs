// Test suite for `ipc::model_roles` (lane R8, issue #791), split into this sibling file via
// `#[path]` only to keep `model_roles.rs` itself under this build's 600-line-per-file cap. Ports
// `src/main/ipc/modelRoles.test.ts`'s `toIpcError` cases and `src/main/omp/config.test.ts`'s pure
// function cases (rawModelRolesRecord, stringEntriesOnly, mergeModelRole, parseCatalogResponse,
// assertValidSelector -- including the "thinking-suffix" selector case -- envWithoutRoleOverrides,
// and the enqueueWrite serialisation guarantee).
use super::*;
use std::time::Duration;

#[test]
fn to_ipc_error_maps_timeout() {
    let err = to_ipc_error(&OmpConfigError::new(
        OmpConfigErrorCode::Timeout,
        "omp config timed out.",
    ));
    assert_eq!(err.code, "timeout");
    assert_eq!(err.message, "omp config timed out.");
}

#[test]
fn to_ipc_error_maps_invalid_value_to_invalid_argument() {
    let err = to_ipc_error(&OmpConfigError::new(
        OmpConfigErrorCode::InvalidValue,
        "Model selector cannot be blank.",
    ));
    assert_eq!(err.code, "invalid-argument");
}

#[test]
fn to_ipc_error_maps_every_other_code_to_omp_probe_failed() {
    for code in [
        OmpConfigErrorCode::OmpNotFound,
        OmpConfigErrorCode::OmpFailed,
        OmpConfigErrorCode::ParseFailed,
    ] {
        assert_eq!(
            to_ipc_error(&OmpConfigError::new(code, "some message")).code,
            "omp-probe-failed"
        );
    }
}

#[test]
fn raw_model_roles_record_empty_for_null() {
    assert_eq!(raw_model_roles_record(&Value::Null).unwrap(), Map::new());
}

#[test]
fn raw_model_roles_record_shallow_copies_and_rejects_non_objects() {
    let mut input = Map::new();
    input.insert(
        "task".into(),
        Value::String("anthropic/claude-sonnet-4-5".into()),
    );
    input.insert("weird".into(), serde_json::json!(["a", "b"]));
    assert_eq!(
        raw_model_roles_record(&Value::Object(input.clone())).unwrap(),
        input
    );
    assert_eq!(
        raw_model_roles_record(&serde_json::json!(["not", "a", "record"]))
            .unwrap_err()
            .code,
        OmpConfigErrorCode::ParseFailed
    );
    assert!(raw_model_roles_record(&serde_json::json!(42)).is_err());
}

#[test]
fn raw_model_roles_record_treats_proto_named_key_as_an_ordinary_key() {
    let value: Value = serde_json::from_str(r#"{"__proto__": {"task": "x"}}"#).unwrap();
    let raw = raw_model_roles_record(&value).unwrap();
    assert!(raw.contains_key("__proto__"));
    let merged = merge_model_role(&raw, "task", Some("anthropic/claude-sonnet-4-5")).unwrap();
    assert_eq!(
        merged.get("task").unwrap().as_str().unwrap(),
        "anthropic/claude-sonnet-4-5"
    );
}

#[test]
fn string_entries_only_keeps_non_blank_strings_only() {
    let mut record = Map::new();
    record.insert(
        "task".into(),
        Value::String("anthropic/claude-sonnet-4-5".into()),
    );
    record.insert("weird".into(), serde_json::json!(["a", "b"]));
    record.insert("smol".into(), Value::String("".into()));
    record.insert("slow".into(), Value::String("   ".into()));
    let result = string_entries_only(&record);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get("task").unwrap(), "anthropic/claude-sonnet-4-5");
}

#[test]
fn merge_model_role_sets_overwrites_and_clears() {
    let mut current = Map::new();
    current.insert("task".into(), Value::String("old/value".into()));
    current.insert("smol".into(), Value::String("openai/gpt-4.1-mini".into()));

    let overwritten = merge_model_role(&current, "task", Some("new/value")).unwrap();
    assert_eq!(
        overwritten.get("task").unwrap().as_str().unwrap(),
        "new/value"
    );
    assert_eq!(
        overwritten.get("smol").unwrap().as_str().unwrap(),
        "openai/gpt-4.1-mini"
    );

    let cleared = merge_model_role(&current, "task", None).unwrap();
    assert!(!cleared.contains_key("task"));
    assert!(cleared.contains_key("smol"));

    assert!(
        merge_model_role(&current, "plan", None).is_none(),
        "clearing an absent role is a no-op"
    );

    let snapshot = current.clone();
    merge_model_role(&current, "smol", Some("new/value"));
    assert_eq!(current, snapshot, "merge never mutates its input");
}

#[test]
fn parse_catalog_response_accepts_both_shapes_and_drops_bad_rows() {
    let valid = serde_json::json!({ "provider": "anthropic", "id": "claude-sonnet-4-5", "selector": "anthropic/claude-sonnet-4-5", "name": "Claude Sonnet 4.5" });
    let expected = vec![ModelCatalogEntry {
        provider: "anthropic".into(),
        id: "claude-sonnet-4-5".into(),
        selector: "anthropic/claude-sonnet-4-5".into(),
        name: "Claude Sonnet 4.5".into(),
    }];
    assert_eq!(
        parse_catalog_response(&serde_json::json!([valid.clone()])).unwrap(),
        expected
    );
    assert_eq!(
        parse_catalog_response(&serde_json::json!({ "models": [valid.clone()] })).unwrap(),
        expected
    );
    assert_eq!(
        parse_catalog_response(&serde_json::json!({ "models": [] })).unwrap(),
        Vec::new()
    );

    let incomplete = serde_json::json!({ "provider": "anthropic", "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5" });
    let wrong_types =
        serde_json::json!({ "provider": 1, "id": "x", "selector": "x/x", "name": "X" });
    let dropped = parse_catalog_response(
        &serde_json::json!({ "models": [incomplete, wrong_types, null, "nope", 42, valid] }),
    )
    .unwrap();
    assert_eq!(dropped.len(), 1);

    assert_eq!(
        parse_catalog_response(&serde_json::json!({ "roles": [] }))
            .unwrap_err()
            .code,
        OmpConfigErrorCode::ParseFailed
    );
    assert!(parse_catalog_response(&Value::Null).is_err());
    assert!(parse_catalog_response(&serde_json::json!("garbage")).is_err());
}

#[test]
fn parse_catalog_response_keeps_only_the_four_needed_fields() {
    let rich = serde_json::json!({
        "provider": "github-copilot", "kind": "chat", "id": "claude-fable-5",
        "selector": "github-copilot/claude-fable-5", "name": "Claude Fable 5",
        "contextWindow": 1_000_000, "reasoning": true,
    });
    let result = parse_catalog_response(&serde_json::json!({ "models": [rich] })).unwrap();
    assert_eq!(
        result,
        vec![ModelCatalogEntry {
            provider: "github-copilot".into(),
            id: "claude-fable-5".into(),
            selector: "github-copilot/claude-fable-5".into(),
            name: "Claude Fable 5".into(),
        }]
    );
}

#[test]
fn assert_valid_selector_accepts_ordinary_and_thinking_suffixed_selectors() {
    assert!(assert_valid_selector("anthropic/claude-sonnet-4-5").is_ok());
    assert!(assert_valid_selector("anthropic/claude-sonnet-4-5:high").is_ok());
    assert!(assert_valid_selector(&"a".repeat(512)).is_ok());
}

#[test]
fn assert_valid_selector_rejects_blank_oversized_and_formatting_characters() {
    assert_eq!(
        assert_valid_selector("").unwrap_err().code,
        OmpConfigErrorCode::InvalidValue
    );
    assert_eq!(
        assert_valid_selector("   ").unwrap_err().code,
        OmpConfigErrorCode::InvalidValue
    );
    assert_eq!(
        assert_valid_selector(&"a".repeat(513)).unwrap_err().code,
        OmpConfigErrorCode::InvalidValue
    );
    for selector in [
        "abc\u{0000}def",
        "abc\ndef",
        "abc\u{007f}def",
        "abc\u{0085}def",
        "abc\u{200b}def",
        "abc\u{202e}def",
        "abc\u{feff}def",
    ] {
        assert!(
            assert_valid_selector(selector).is_err(),
            "expected {selector:?} to be rejected"
        );
    }
}

#[test]
fn env_without_role_overrides_strips_case_insensitively() {
    let mut env = HashMap::new();
    env.insert("PI_SMOL_MODEL".to_string(), "x/y".to_string());
    env.insert("Pi_Config_Files".to_string(), "a;b".to_string());
    env.insert("OTHER".to_string(), "kept".to_string());
    let result = env_without_role_overrides(&env);
    assert_eq!(
        result,
        HashMap::from([("OTHER".to_string(), "kept".to_string())])
    );
    assert!(env_without_role_overrides(&HashMap::new()).is_empty());
}

/// Proves the serialisation primitive `MODEL_ROLES_WRITE_LOCK` uses (a `tokio::sync::Mutex` held
/// across the whole operation) runs two queued tasks strictly in acquire order, never overlapping
/// -- the same guarantee `enqueueWrite`'s own TS test proved for its promise chain. Uses a fresh
/// local mutex (not the real static) so this never contends with other concurrently-running
/// tests.
#[tokio::test]
async fn write_lock_runs_two_queued_tasks_strictly_in_order_and_releases_after_each() {
    let lock = std::sync::Arc::new(AsyncMutex::new(()));
    let events = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<&'static str>::new()));

    let (lock_a, events_a) = (lock.clone(), events.clone());
    let task_a = tokio::spawn(async move {
        let _guard = lock_a.lock().await;
        events_a.lock().await.push("A-start");
        tokio::time::sleep(Duration::from_millis(20)).await;
        events_a.lock().await.push("A-end");
    });
    tokio::time::sleep(Duration::from_millis(1)).await; // ensure A acquires first.
    let (lock_b, events_b) = (lock.clone(), events.clone());
    let task_b = tokio::spawn(async move {
        let _guard = lock_b.lock().await;
        events_b.lock().await.push("B-start");
        events_b.lock().await.push("B-end");
    });
    let _ = tokio::join!(task_a, task_b);
    assert_eq!(
        *events.lock().await,
        vec!["A-start", "A-end", "B-start", "B-end"]
    );

    // A guard dropped after an early return (simulating `set_model_role_now` failing partway
    // through) must never wedge a later acquire behind it.
    let acquired = tokio::time::timeout(Duration::from_millis(50), lock.lock()).await;
    assert!(acquired.is_ok());
}
