use super::*;

#[test]
fn contract_declares_the_v1_actions() {
    assert_eq!(is_mutating("git-changes", "stage_file"), Some(true));
    assert_eq!(is_mutating("git-changes", "unstage_file"), Some(true));
    assert_eq!(is_mutating("git-changes", "show_file"), Some(false));
    assert_eq!(is_mutating("file-explorer", "reveal"), Some(false));
    assert_eq!(is_mutating("side-chat", "open"), Some(false));
    assert_eq!(is_mutating("git-changes", "nope"), None);
    assert_eq!(is_mutating("nope", "open"), None);
    assert!(panel("outline").unwrap().actions.is_empty());
}

#[test]
fn tool_parameters_list_every_panel_id() {
    let schema = tool_parameters(OPEN_PANEL);
    let ids = schema["properties"]["panelId"]["enum"].as_array().unwrap();
    assert_eq!(ids.len(), panel_ids().len());
}

#[test]
fn validate_accepts_a_matching_object() {
    let schema = &action("git-changes", "stage_file").unwrap().input_schema;
    assert!(validate(schema, &json!({ "path": "src/a.ts" }), "input").is_ok());
}

#[test]
fn validate_rejects_missing_unknown_and_mistyped_keys() {
    let schema = &action("git-changes", "stage_file").unwrap().input_schema;
    assert!(validate(schema, &json!({}), "input")
        .unwrap_err()
        .contains("required"));
    assert!(validate(schema, &json!({ "path": "a", "x": 1 }), "input")
        .unwrap_err()
        .contains("not allowed"));
    assert!(validate(schema, &json!({ "path": 3 }), "input")
        .unwrap_err()
        .contains("string"));
}

#[test]
fn validate_rejects_paths_outside_the_worktree() {
    let schema = &action("git-changes", "stage_file").unwrap().input_schema;
    for bad in ["../x", "a/../../x", "/etc/passwd", "C:\\x", "\\\\host\\share", ""] {
        assert!(
            validate(schema, &json!({ "path": bad }), "input").is_err(),
            "{bad}"
        );
    }
}

#[test]
fn validate_checks_enum_and_minimum() {
    let schema = json!({ "type": "integer", "minimum": 1 });
    assert!(validate(&schema, &json!(0), "n").is_err());
    assert!(validate(&schema, &json!(2), "n").is_ok());
    let schema = json!({ "enum": ["a"] });
    assert!(validate(&schema, &json!("b"), "v").is_err());
}
