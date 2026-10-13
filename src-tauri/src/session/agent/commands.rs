// Slash-command filtering/classification tables (port of `slash-commands.ts`). See `mod.rs`'s
// own header for this module's place in the `agent/` split and the lane extension contract.

use serde_json::{json, Value};

pub(super) fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Port of `slash-commands.ts`'s own `SUPPORTED_OMP_COMMANDS` table.
fn supported_omp_subcommands(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "fast" => Some(&["on", "ultra", "off", "status"]),
        "slow" => Some(&["on", "off", "status"]),
        "extended-context" => Some(&["on", "off", "status"]),
        "prewalk" => Some(&["restart"]),
        "effort" => Some(&[
            "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
        ]),
        "dump" => Some(&["all"]),
        "todo" => Some(&["expand", "collapse", "append", "start", "done", "rm"]),
        "session" => Some(&["info"]),
        "jobs" => Some(&["full"]),
        "usage" => Some(&["show"]),
        "changelog" => Some(&["full", "last"]),
        "tools" | "context" | "fresh" | "retry" | "rename" | "add-dir" | "dirs" | "force"
        | "autoresearch" | "annotate" => Some(&[]),
        "shake" => Some(&["elide", "images", "thinking"]),
        _ => None,
    }
}

/// Refract's own native commands (`NATIVE_BUILT_COMMANDS`): `/new` has a working implementation
/// (`start_new_conversation`); `/btw` is listed for menu parity with the Electron build but has
/// no implementation here (side chat out of scope, see `mod.rs`'s own header) -- `ipc::chat`'s
/// own `NATIVE_RESERVED_COMMANDS` check refuses it with `unknown-command` before classification
/// ever reaches `chat.send`, so this module never sees a `/btw` invocation to special-case.
const NATIVE_BUILT_COMMANDS: &[(&str, &str)] = &[
    ("new", "Start a new Conversation in this Session"),
    ("btw", "Ask the agent a side question"),
];

/// Port of `slash-commands.ts`'s own `filterSupportedCommands`.
pub(super) fn filter_supported_commands(raw: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = NATIVE_BUILT_COMMANDS
        .iter()
        .map(|(name, description)| json!({ "name": name, "description": description }))
        .collect();
    for command in raw {
        let Some(name) = command.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(allowed) = supported_omp_subcommands(name) else {
            continue;
        };
        let mut pruned = command.clone();
        if let Some(subs) = command.get("subcommands").and_then(Value::as_array) {
            let filtered: Vec<Value> = subs
                .iter()
                .filter(|sub| {
                    sub.get("name")
                        .and_then(Value::as_str)
                        .map(|n| allowed.contains(&n))
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            pruned["subcommands"] = Value::Array(filtered);
        }
        out.push(pruned);
    }
    out
}

/// Port of `slash-commands.ts`'s own `parseSlashCommand`.
pub fn parse_slash_command(text: &str) -> Option<(String, String)> {
    let trimmed = text.trim_start();
    let body = trimmed.strip_prefix('/')?;
    let space_idx = body.find(char::is_whitespace);
    let name = match space_idx {
        Some(idx) => &body[..idx],
        None => body,
    };
    if name.is_empty() {
        return None;
    }
    let rest = match space_idx {
        Some(idx) => body[idx + 1..].trim().to_string(),
        None => String::new(),
    };
    Some((name.to_string(), rest))
}

/// Port of `slash-commands.ts`'s own `SlashInvocationClassification`/`classifySlashInvocation`.
pub enum SlashInvocationClassification {
    Supported,
    UnknownCommand,
    UnsupportedArguments,
}

pub fn classify_slash_invocation(
    name: &str,
    rest: &str,
    commands: &[Value],
) -> SlashInvocationClassification {
    let descriptor = commands.iter().find(|c| {
        c.get("name").and_then(Value::as_str) == Some(name)
            || c.get("aliases")
                .and_then(Value::as_array)
                .map(|a| a.iter().any(|v| v.as_str() == Some(name)))
                .unwrap_or(false)
    });
    let Some(descriptor) = descriptor else {
        return SlashInvocationClassification::UnknownCommand;
    };
    if rest.is_empty() {
        return SlashInvocationClassification::Supported;
    }
    let space_idx = rest.find(' ');
    let sub_name = match space_idx {
        Some(idx) => &rest[..idx],
        None => rest,
    };
    let extra = match space_idx {
        Some(idx) => rest[idx + 1..].trim(),
        None => "",
    };
    if !extra.is_empty() {
        return SlashInvocationClassification::UnsupportedArguments;
    }
    let supported = descriptor
        .get("subcommands")
        .and_then(Value::as_array)
        .map(|subs| {
            subs.iter()
                .any(|s| s.get("name").and_then(Value::as_str) == Some(sub_name))
        })
        .unwrap_or(false);
    if supported {
        SlashInvocationClassification::Supported
    } else {
        SlashInvocationClassification::UnsupportedArguments
    }
}
