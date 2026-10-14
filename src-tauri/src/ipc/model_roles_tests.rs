// Test suite for `ipc::model_roles` (lane R8, issue #791), split into this sibling file via
// `#[path]` only to keep `model_roles.rs` itself under this build's 600-line-per-file cap. Ports
// `src/main/ipc/modelRoles.test.ts`'s `toIpcError` cases, `src/main/omp/config.test.ts`'s pure
// function cases, and `src/main/omp/config.cli.test.ts`'s real-code behavioural guarantees
// (serialised read-merge-write, role/kind rejected before `omp` runs, `overriddenBy` carried
// through, env stripping asymmetry) via `FakeModelRolesExecutor`, a fake `OmpExecutor` that never
// spawns a real process.
use super::*;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;

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
    assert!(raw_model_roles_record(&Value::String("nope".into())).is_err());
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

// ---------------------------------------------------------------------------
// `FakeModelRolesExecutor`: a fake `OmpExecutor` simulating `omp config get/set modelRoles` in
// memory (no real process), letting these tests prove the REAL `set_model_role`/
// `MODEL_ROLES_WRITE_LOCK`/`list_catalog_models` behave correctly -- not a stand-in primitive.
struct FakeModelRolesExecutor {
    state: TokioMutex<Map<String, Value>>,
    calls: TokioMutex<Vec<(Vec<String>, Vec<String>)>>,
    set_delay_ms: u64,
    overridden_by: Option<String>,
}

impl FakeModelRolesExecutor {
    fn new(set_delay_ms: u64, overridden_by: Option<&str>) -> Self {
        Self {
            state: TokioMutex::new(Map::new()),
            calls: TokioMutex::new(Vec::new()),
            set_delay_ms,
            overridden_by: overridden_by.map(str::to_string),
        }
    }
}

impl OmpExecutor for FakeModelRolesExecutor {
    fn call<'a>(
        &'a self,
        args: &'a [String],
        _failure_message: &'a str,
        strip_env_vars: &'a [&'a str],
    ) -> Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().await.push((
                args.to_vec(),
                strip_env_vars.iter().map(|s| s.to_string()).collect(),
            ));
            if args.get(1).map(String::as_str) == Some("set") {
                if self.set_delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(self.set_delay_ms)).await;
                }
                let value_json = args.last().expect("set call always carries a value");
                let value: Value = serde_json::from_str(value_json)
                    .expect("fake only ever receives JSON its own caller built");
                *self.state.lock().await = value.as_object().cloned().unwrap_or_default();
                let mut response = serde_json::json!({ "key": args[2], "value": value });
                if let Some(overridden_by) = &self.overridden_by {
                    response["overriddenBy"] = Value::String(overridden_by.clone());
                }
                return Ok(response.to_string());
            }
            let state = self.state.lock().await;
            Ok(serde_json::json!({ "key": args.get(2).cloned().unwrap_or_default(), "value": Value::Object(state.clone()), "type": "record", "description": "" }).to_string())
        })
    }
}

/// Ports `config.cli.test.ts`'s "setModelRole keeps the whole read-merge-write inside the
/// enqueued task": a slow first SET must delay the second role's own READ, and the second SET
/// must carry both keys (proving the second task's merge read the first task's ALREADY-WRITTEN
/// value, not a stale pre-lock copy) -- against the real `set_model_role_with`/
/// `MODEL_ROLES_WRITE_LOCK`, not a stand-in mutex. No sleep decides which task runs first: the
/// assertions hold for whichever task wins that race, because they check group-of-three call
/// ordering (get, set, re-read) never interleaves across tasks, not a specific interleaving.
#[tokio::test]
async fn set_model_role_with_serialises_two_concurrent_calls_and_merges_both_writes() {
    let fake = Arc::new(FakeModelRolesExecutor::new(30, None));

    let fake_a = fake.clone();
    let task_a = tokio::spawn(async move {
        set_model_role_with(fake_a.as_ref(), "task", Some("anthropic/claude-sonnet-4-5")).await
    });
    let fake_b = fake.clone();
    let task_b = tokio::spawn(async move {
        set_model_role_with(fake_b.as_ref(), "smol", Some("openai/gpt-4.1-mini")).await
    });

    let (result_a, result_b) = tokio::join!(task_a, task_b);
    let result_a = result_a.unwrap().unwrap();
    let result_b = result_b.unwrap().unwrap();

    // By the time BOTH calls have returned, both roles are present in whichever result reflects
    // the later write.
    let final_roles = if result_a.roles.len() >= result_b.roles.len() {
        result_a.roles
    } else {
        result_b.roles
    };
    assert_eq!(
        final_roles.get("task"),
        Some(&"anthropic/claude-sonnet-4-5".to_string())
    );
    assert_eq!(
        final_roles.get("smol"),
        Some(&"openai/gpt-4.1-mini".to_string())
    );

    let calls = fake.calls.lock().await;
    assert_eq!(calls.len(), 6, "each set_model_role call makes exactly 3 omp calls (stripped-get, stripped-set, full re-read)");
    // Calls 0,1,2 belong to whichever task ran first; 3,4,5 to the other. If the lock did not
    // cover the whole read-merge-write, the second task's own GET could land at index 1 (where
    // the first task's SET belongs) instead -- this is exactly what the assertion below rules out.
    assert_eq!(calls[0].0[1], "get");
    assert_eq!(
        calls[1].0[1], "set",
        "no interleaving: the second call in each group of three must be that SAME task's own set"
    );
    assert_eq!(calls[2].0[1], "get");
    assert_eq!(calls[3].0[1], "get");
    assert_eq!(calls[4].0[1], "set");
    assert_eq!(calls[5].0[1], "get");
    // The second SET (whichever task it belongs to) carries BOTH roles -- its merge-read saw the
    // first task's already-written value.
    let second_set_value = calls[4].0.last().unwrap();
    assert!(second_set_value.contains("anthropic/claude-sonnet-4-5"));
    assert!(second_set_value.contains("openai/gpt-4.1-mini"));
    // Env stripping asymmetry: both the merge-read (index 0) and the set (index 1) strip the
    // four role-override variables; the final re-read (index 2) uses the full environment.
    assert_eq!(calls[0].1, ROLE_OVERRIDE_ENV_VARS.to_vec());
    assert_eq!(calls[1].1, ROLE_OVERRIDE_ENV_VARS.to_vec());
    assert!(calls[2].1.is_empty());
}

#[tokio::test]
async fn set_model_role_with_rejects_an_unknown_role_before_ever_calling_omp() {
    let fake = FakeModelRolesExecutor::new(0, None);
    let err = set_model_role_with(&fake, "not-a-real-role", Some("x/y"))
        .await
        .unwrap_err();
    assert_eq!(err.code, OmpConfigErrorCode::InvalidValue);
    assert!(fake.calls.lock().await.is_empty());
}

#[tokio::test]
async fn list_catalog_models_with_rejects_an_unknown_kind_before_ever_calling_omp() {
    let fake = FakeModelRolesExecutor::new(0, None);
    let err = list_catalog_models_with(&fake, "not-a-real-kind")
        .await
        .unwrap_err();
    assert_eq!(err.code, OmpConfigErrorCode::InvalidValue);
    assert!(fake.calls.lock().await.is_empty());
}

#[tokio::test]
async fn set_model_role_with_passes_overridden_by_through() {
    let fake = FakeModelRolesExecutor::new(0, Some("project"));
    let result = set_model_role_with(&fake, "task", Some("anthropic/claude-sonnet-4-5"))
        .await
        .unwrap();
    assert_eq!(result.overridden_by, Some("project".to_string()));
}

#[tokio::test]
async fn set_model_role_with_carries_a_thinking_suffix_through_merge_and_write() {
    let fake = FakeModelRolesExecutor::new(0, None);
    let result = set_model_role_with(&fake, "task", Some("anthropic/claude-sonnet-4-5:high"))
        .await
        .unwrap();
    assert_eq!(
        result.roles.get("task"),
        Some(&"anthropic/claude-sonnet-4-5:high".to_string())
    );
}

#[tokio::test]
async fn set_model_role_with_clearing_an_already_unset_role_skips_the_set_call() {
    let fake = FakeModelRolesExecutor::new(0, None);
    let result = set_model_role_with(&fake, "task", None).await.unwrap();
    assert!(result.roles.is_empty());
    // Only the one stripped-env merge-read ran; no `set` and no re-read, since nothing changed.
    assert_eq!(fake.calls.lock().await.len(), 1);
}
