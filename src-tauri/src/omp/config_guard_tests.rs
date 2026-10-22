use serde_json::json;

use super::*;

fn baseline_list() -> Value {
    let mut list = serde_json::Map::new();
    for (key, value) in scalar_baseline() {
        list.insert(key.to_string(), json!({ "value": value }));
    }
    let record: serde_json::Map<String, Value> = MODEL_THRESHOLDS
        .iter()
        .map(|(m, l)| (m.to_string(), Value::from(*l)))
        .collect();
    list.insert(THRESHOLDS_KEY.to_string(), json!({ "value": record }));
    list.insert(
        "modelRoles".to_string(),
        json!({ "value": { "advisor": ADVISOR_SELECTOR } }),
    );
    Value::Object(list)
}

#[test]
fn normalise_treats_representations_as_equal() {
    assert_eq!(normalise(&json!(120000)), normalise(&json!("120000")));
    assert_eq!(normalise(&json!(120000.0)), normalise(&json!("120000")));
    assert_eq!(normalise(&json!(true)), normalise(&json!("true")));
    assert_ne!(normalise(&json!(true)), normalise(&json!(false)));
    assert_eq!(normalise(&Value::Null), None);
}

#[test]
fn matching_baseline_is_not_drift() {
    assert!(plan_drift(&baseline_list()).is_empty());
}

#[test]
fn string_formatted_values_are_not_drift() {
    let mut list = baseline_list();
    list["task.maxConcurrency"] = json!({ "value": "6" });
    list["compaction.idleEnabled"] = json!({ "value": "true" });
    assert!(plan_drift(&list).is_empty());
}

#[test]
fn scalar_and_role_drift_is_reported_with_old_value() {
    let mut list = baseline_list();
    list["advisor.reviewMode"] = json!({ "value": "turn" });
    list["modelRoles"] = json!({ "value": { "advisor": "other/model" } });
    let drifts = plan_drift(&list);
    assert_eq!(drifts.len(), 2);
    assert_eq!(drifts[0].key, "advisor.reviewMode");
    assert_eq!(drifts[0].old, Some(json!("turn")));
    assert_eq!(drifts[1].kind, DriftKind::AdvisorRole);
}

#[test]
fn thresholds_compare_per_entry_and_leave_extras_alone() {
    let mut list = baseline_list();
    list[THRESHOLDS_KEY] = json!({ "value": {
        "github-copilot/claude-opus-5.5": 900000,
        "github-copilot/claude-sonnet-5.5": "120000",
        "github-copilot/claude-sonnet-5": 120000,
        "github-copilot/claude-haiku-5.5": 120000,
        "github-copilot/gemini-4-argon": 150000,
        "github-copilot/gpt-5.6-terra": 150000,
        "x/extra": 1
    }});
    let drifts = plan_drift(&list);
    assert_eq!(drifts.len(), 1);
    assert_eq!(
        drifts[0].kind,
        DriftKind::Threshold("github-copilot/claude-opus-5.5".into())
    );
}

#[test]
fn keys_unknown_to_omp_are_skipped() {
    assert!(plan_drift(&json!({})).is_empty());
}

#[test]
fn yaml_scan_finds_nested_and_flat_override_paths() {
    let yaml = "# c\ncompaction:\n  thresholdTokens: 1\n  modelThresholds:\n    \"a/b.5\": 2\nadvisor.reviewMode: turn\ntask:\n  other: 1\nlist:\n  - x: 1\n";
    let paths = scan_yaml_paths(yaml);
    assert!(paths.contains(&"compaction.thresholdTokens".to_string()));
    assert!(paths.contains(&"compaction.modelThresholds.a/b.5".to_string()));
    let keys = overridden_guarded_keys(&paths);
    assert_eq!(
        keys,
        vec![
            "advisor.reviewMode",
            "compaction.thresholdTokens",
            "compaction.modelThresholds"
        ]
    );
}
