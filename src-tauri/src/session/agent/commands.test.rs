// Unit tests for `session::agent::commands` (lane R4, issue #787; gate-fix round 1):
// `parse_slash_command`, `is_builtin_source`, the source-aware `filter_supported_commands`, and
// `classify_slash_invocation` including the anti-shadow fix (a file/skill command sharing a
// builtin's name or alias must never inherit the free-form policy). `#[path]`-loaded sibling of
// `commands.rs` (excluded from `check:file-size` by its own `.test.rs` name).

use super::*;

// ---------------------------------------------------------------------------
// parse_slash_command
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// is_builtin_source
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// filter_supported_commands
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// classify_slash_invocation
// ---------------------------------------------------------------------------

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

/// Gate-fix regression test (High/Medium, security): a file/skill command sharing a builtin's
/// exact name must still be classified against the BUILTIN's own rules once arguments are given
/// -- never granted free-form arguments just because a `.find()` happened to pick the file
/// descriptor first.
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
    // Free-form text that is NOT the builtin's verified subcommand: must be refused, not
    // silently accepted as if it were the file command's own free-form policy.
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
