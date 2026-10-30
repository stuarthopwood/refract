// Unit tests for `session::agent::commands`.

use super::*;

#[test]
fn parse_slash_command_bare_name() {
    assert_eq!(
        parse_slash_command("/new"),
        Some(("new".to_string(), String::new()))
    );
}

#[test]
fn parse_slash_command_with_arguments() {
    assert_eq!(
        parse_slash_command("/rename foo bar"),
        Some(("rename".to_string(), "foo bar".to_string()))
    );
}

#[test]
fn parse_slash_command_trims_leading_whitespace_and_trailing_rest() {
    assert_eq!(
        parse_slash_command("   /foo   bar  "),
        Some(("foo".to_string(), "bar".to_string()))
    );
}

#[test]
fn parse_slash_command_none_for_ordinary_text() {
    assert_eq!(parse_slash_command("not a command"), None);
}

#[test]
fn parse_slash_command_none_for_a_bare_slash() {
    assert_eq!(parse_slash_command("/"), None);
    assert_eq!(parse_slash_command("/   "), None);
}

#[test]
fn is_builtin_source_table() {
    assert!(
        is_builtin_source(None),
        "missing source fails closed to builtin-restricted"
    );
    assert!(is_builtin_source(Some("builtin")));
    assert!(is_builtin_source(Some("native")));
    assert!(
        is_builtin_source(Some("some-future-value")),
        "unprobed values fail closed too"
    );
    assert!(!is_builtin_source(Some("file")));
    assert!(!is_builtin_source(Some("skill")));
}

#[test]
fn filter_supported_commands_always_prepends_native_built_commands() {
    let out = filter_supported_commands(&[]);
    let names: Vec<&str> = out
        .iter()
        .filter_map(|c| c.get("name").and_then(Value::as_str))
        .collect();
    assert!(names.contains(&"new"));
    assert!(names.contains(&"btw"));
    assert_eq!(out[0].get("source").and_then(Value::as_str), Some("native"));
}

#[test]
fn filter_supported_commands_drops_an_unverified_builtin() {
    let raw = vec![json!({ "name": "ratchet", "source": "builtin" })];
    let out = filter_supported_commands(&raw);
    assert!(out
        .iter()
        .all(|c| c.get("name").and_then(Value::as_str) != Some("ratchet")));
}

#[test]
fn filter_supported_commands_prunes_a_verified_builtins_subcommands() {
    let raw = vec![json!({
        "name": "todo",
        "source": "builtin",
        "subcommands": [
            { "name": "expand" },
            { "name": "copy" }, // not in the verified table
        ]
    })];
    let out = filter_supported_commands(&raw);
    let todo = out
        .iter()
        .find(|c| c.get("name").and_then(Value::as_str) == Some("todo"))
        .expect("todo listed");
    let subs: Vec<&str> = todo
        .get("subcommands")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .filter_map(|s| s.get("name").and_then(Value::as_str))
        .collect();
    assert_eq!(subs, vec!["expand"]);
}

#[test]
fn filter_supported_commands_passes_through_a_file_sourced_command_unpruned() {
    let raw = vec![json!({
        "name": "check-build",
        "source": "file",
        "description": "Run the project build check",
        "subcommands": [{ "name": "whatever-unverified" }]
    })];
    let out = filter_supported_commands(&raw);
    let found = out
        .iter()
        .find(|c| c.get("name").and_then(Value::as_str) == Some("check-build"))
        .expect("file command listed");
    let subs = found.get("subcommands").and_then(Value::as_array).unwrap();
    assert_eq!(subs.len(), 1, "a file-sourced command is never pruned");
}

#[test]
fn filter_supported_commands_passes_through_a_skill_sourced_command() {
    let raw = vec![json!({ "name": "skill:my-skill", "source": "skill" })];
    let out = filter_supported_commands(&raw);
    assert!(out
        .iter()
        .any(|c| c.get("name").and_then(Value::as_str) == Some("skill:my-skill")));
}

fn builtin(name: &str, subcommands: &[&str]) -> Value {
    json!({
        "name": name,
        "source": "builtin",
        "subcommands": subcommands.iter().map(|s| json!({ "name": s })).collect::<Vec<_>>(),
    })
}

fn file_command(name: &str) -> Value {
    json!({ "name": name, "source": "file" })
}

#[test]
fn classify_unknown_name() {
    let commands = vec![builtin("usage", &["show"])];
    assert!(matches!(
        classify_slash_invocation("nonexistent", "", &commands),
        SlashInvocationClassification::UnknownCommand
    ));
}

#[test]
fn classify_builtin_bare_name_is_supported() {
    let commands = vec![builtin("usage", &["show"])];
    assert!(matches!(
        classify_slash_invocation("usage", "", &commands),
        SlashInvocationClassification::Supported
    ));
}

#[test]
fn classify_builtin_verified_subcommand_is_supported() {
    let commands = vec![builtin("usage", &["show"])];
    assert!(matches!(
        classify_slash_invocation("usage", "show", &commands),
        SlashInvocationClassification::Supported
    ));
}

#[test]
fn classify_builtin_unverified_subcommand_is_refused() {
    let commands = vec![builtin("usage", &["show"])];
    assert!(matches!(
        classify_slash_invocation("usage", "nonsense", &commands),
        SlashInvocationClassification::UnsupportedArguments
    ));
}

#[test]
fn classify_builtin_trailing_extra_text_is_refused() {
    let commands = vec![builtin("usage", &["show"])];
    assert!(matches!(
        classify_slash_invocation("usage", "show extra", &commands),
        SlashInvocationClassification::UnsupportedArguments
    ));
}

#[test]
fn classify_file_sourced_command_runs_with_free_form_arguments() {
    let commands = vec![file_command("check-build")];
    assert!(matches!(
        classify_slash_invocation("check-build", "any free text at all", &commands),
        SlashInvocationClassification::Supported
    ));
}

#[test]
fn classify_matches_an_alias() {
    let mut command = builtin("model", &[]);
    command["aliases"] = json!(["models"]);
    let commands = vec![command];
    assert!(matches!(
        classify_slash_invocation("models", "", &commands),
        SlashInvocationClassification::Supported
    ));
}

/// A file command sharing a builtin's name keeps the builtin's argument rules.
#[test]
fn classify_a_file_command_shadowing_a_builtin_name_stays_builtin_restricted() {
    let commands = vec![
        file_command("session"), // listed first: a naive `.find()` would pick this one
        builtin("session", &["info"]),
    ];
    // Bare name: still supported either way.
    assert!(matches!(
        classify_slash_invocation("session", "", &commands),
        SlashInvocationClassification::Supported
    ));
    // The builtin's own verified subcommand: still supported.
    assert!(matches!(
        classify_slash_invocation("session", "info", &commands),
        SlashInvocationClassification::Supported
    ));
    // Free-form text that is not the builtin's verified subcommand must be refused.
    assert!(matches!(
        classify_slash_invocation("session", "delete", &commands),
        SlashInvocationClassification::UnsupportedArguments
    ));
}

#[test]
fn classify_a_file_command_shadowing_a_builtin_via_alias_stays_builtin_restricted() {
    let mut builtin_cmd = builtin("model", &[]);
    builtin_cmd["aliases"] = json!(["models"]);
    let commands = vec![file_command("models"), builtin_cmd];
    assert!(matches!(
        classify_slash_invocation("models", "unexpected argument", &commands),
        SlashInvocationClassification::UnsupportedArguments
    ));
}

#[test]
fn classify_a_skill_sourced_command_runs_with_free_form_arguments() {
    let commands = vec![json!({ "name": "skill:my-skill", "source": "skill" })];
    assert!(matches!(
        classify_slash_invocation("skill:my-skill", "arg1 arg2", &commands),
        SlashInvocationClassification::Supported
    ));
}

#[test]
fn classify_a_descriptor_with_no_source_field_fails_closed_to_builtin_restricted() {
    // No `source` key at all is treated like `source:"builtin"` with no verified subcommands.
    let commands = vec![json!({ "name": "mystery" })];
    assert!(matches!(
        classify_slash_invocation("mystery", "", &commands),
        SlashInvocationClassification::Supported
    ));
    assert!(matches!(
        classify_slash_invocation("mystery", "anything", &commands),
        SlashInvocationClassification::UnsupportedArguments
    ));
}

/// A builtin dropped by the allow-list filter must still shadow a same-named file command.
#[test]
fn raw_to_filter_to_classify_a_file_command_cannot_assume_a_hidden_builtins_name() {
    let raw = vec![
        json!({ "name": "model", "source": "builtin" }), // never allow-listed (not in SUPPORTED_OMP_COMMANDS)
        json!({ "name": "model", "source": "file", "description": "a user command named model" }),
    ];
    let filtered = filter_supported_commands(&raw);
    // The file command sharing a hidden builtin's name must also stay absent.
    assert!(
        !filtered
            .iter()
            .any(|c| c.get("name").and_then(Value::as_str) == Some("model")),
        "a file command sharing a hidden builtin's name must never survive filtering: {filtered:?}"
    );
    assert!(matches!(
        classify_slash_invocation("model", "anything", &filtered),
        SlashInvocationClassification::UnknownCommand
    ));
}

#[test]
fn raw_to_filter_to_classify_a_file_command_cannot_assume_a_hidden_builtins_alias() {
    let raw = vec![
        json!({ "name": "ratchet", "aliases": ["rt"], "source": "builtin" }), // hidden (starts-agent-turn class, never allow-listed)
        json!({ "name": "rt", "source": "file", "description": "a user command aliased to rt" }),
    ];
    let filtered = filter_supported_commands(&raw);
    assert!(
        !filtered.iter().any(|c| c.get("name").and_then(Value::as_str) == Some("rt")),
        "a file command colliding with a hidden builtin's ALIAS must never survive filtering: {filtered:?}"
    );
    assert!(matches!(
        classify_slash_invocation("rt", "anything", &filtered),
        SlashInvocationClassification::UnknownCommand
    ));
}

#[test]
fn filter_supported_commands_keeps_a_file_command_with_no_real_collision() {
    let raw = vec![
        json!({ "name": "model", "source": "builtin" }),
        json!({ "name": "check-build", "source": "file" }), // a genuinely different name
    ];
    let filtered = filter_supported_commands(&raw);
    assert!(filtered
        .iter()
        .any(|c| c.get("name").and_then(Value::as_str) == Some("check-build")));
}

/// Native reserved commands (`plan`, `resume`, ...) must never be listed as file commands.
#[test]
fn filter_supported_commands_drops_a_file_command_named_after_a_reserved_native_command() {
    let raw = vec![
        json!({ "name": "plan", "source": "file", "description": "a user command named plan" }),
        json!({ "name": "resume", "aliases": ["res"], "source": "skill" }),
    ];
    let filtered = filter_supported_commands(&raw);
    assert!(
        !filtered
            .iter()
            .any(|c| c.get("name").and_then(Value::as_str) == Some("plan")),
        "a file command named `plan` must never be listed: {filtered:?}"
    );
    assert!(
        !filtered
            .iter()
            .any(|c| c.get("name").and_then(Value::as_str) == Some("resume")),
        "a skill command named `resume` must never be listed: {filtered:?}"
    );
}
