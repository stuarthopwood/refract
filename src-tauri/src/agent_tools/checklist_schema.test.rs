use super::*;

#[test]
fn description_requires_seen_rev_and_get_before_edit() {
    let text = description();
    assert!(text.contains("seenRev"));
    assert!(text.contains("call `get` before you edit"));
}

#[test]
fn description_says_not_checklist_mode_and_todo_for_scratch() {
    let text = description();
    assert!(text.contains("not the working mode's plan"));
    assert!(text.contains("OMP todo is for your own scratch"));
    assert!(text.contains("`owner` to `human`"));
}

fn collect_property_keys(node: &Value, out: &mut Vec<String>) {
    match node {
        Value::Object(map) => {
            if let Some(Value::Object(props)) = map.get("properties") {
                out.extend(props.keys().cloned());
            }
            map.values().for_each(|v| collect_property_keys(v, out));
        }
        Value::Array(items) => items.iter().for_each(|v| collect_property_keys(v, out)),
        _ => {}
    }
}

#[test]
fn parameters_have_no_session_or_checklist_id() {
    let schema = parameters();
    let mut keys = Vec::new();
    collect_property_keys(&schema, &mut keys);
    assert!(keys.iter().any(|k| k == "requiresValue"));
    for key in keys {
        let lower = key.to_lowercase();
        assert!(
            !lower.contains("session") && !lower.contains("checklistid"),
            "{key}"
        );
    }
    assert_eq!(schema["additionalProperties"], json!(false));
}

#[test]
fn parameters_cap_ops_at_20() {
    assert_eq!(parameters()["properties"]["ops"]["maxItems"], json!(20));
    assert_eq!(
        parameters()["properties"]["ops"]["maxItems"],
        json!(crate::checklist::model::MAX_OPS)
    );
}

#[test]
fn parameters_expose_owner_enum_on_create_items_and_add() {
    let schema = parameters();
    let expected = json!(["agent", "human", "either"]);
    let create_item = &schema["properties"]["items"]["items"]["properties"]["owner"];
    let add_item =
        &schema["properties"]["ops"]["items"]["properties"]["item"]["properties"]["owner"];
    assert_eq!(create_item["enum"], expected);
    assert_eq!(add_item["enum"], expected);
}

#[test]
fn status_enum_matches_item_status_all() {
    let schema = parameters();
    let listed = &schema["properties"]["ops"]["items"]["properties"]["status"]["enum"];
    assert_eq!(listed, &json!(crate::checklist::model::ItemStatus::ALL));
}

#[test]
fn agent_completable_description_names_the_complete_this_step_send() {
    let schema = parameters();
    let item = &schema["properties"]["items"]["items"]["properties"]["agentCompletable"];
    let text = item["description"].as_str().unwrap();
    assert!(text.contains("complete this step"));
    assert!(!text.contains("Whether you may"));
}
