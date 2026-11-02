// Slash-command filtering and classification, with the source-aware policy (#760).

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

/// Built-in OMP commands Refract supports, with their verified subcommands.
fn supported_omp_subcommands(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "fast" => Some(&["on", "ultra", "off", "status"]),
        "slow" => Some(&["on", "off", "status"]),
        "extended-context" => Some(&["on", "off", "status"]),
        // Listed without a probe, verified by a live check instead (#917).
        "advisor" => Some(&["on", "off", "status"]),
        "prewalk" => Some(&["restart", "off"]),
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
        | "autoresearch" | "annotate" | "forget-approvals" => Some(&[]),
        "shake" => Some(&["elide", "images", "thinking"]),
        // Takes a free-form model/role argument, checked by `classify_against_builtin` (#762).
        "switch" => Some(&[]),
        _ => None,
    }
}

/// Only `file` and `skill` sources are non-builtin. Any other value, or none, fails closed as builtin.
/// Trusting an unknown source would allow free-form arguments on it.
fn is_builtin_source(source: Option<&str>) -> bool {
    !matches!(source, Some("file") | Some("skill"))
}

/// Refract's native command names, refused locally and never forwarded as a prompt.
/// `ipc::chat` shares this list for both the send refusal and the menu exclusion.
pub const NATIVE_RESERVED_COMMANDS: &[&str] = &[
    "new",
    "resume",
    "plan",
    "fork",
    "settings",
    "pause",
    "plan-review",
    "btw",
    // `/model` is rewritten to `/switch` upstream; reserved here too, in case that rewrite is bypassed.
    "model",
    // Opens Settings client-side; never forwarded to OMP.
    "models",
    // `/role` alone is handled in the renderer; `/role <role>` is special-cased in `ipc::chat`.
    "role",
];

/// Refract's native commands. `/btw` is listed for menu parity but is refused before classification.
/// Tagged `source: "native"` so the menu can tell them apart from OMP's commands.
const NATIVE_BUILT_COMMANDS: &[(&str, &str)] = &[
    ("new", "Start a new Conversation in this Session"),
    ("btw", "Ask the agent a side question"),
    // Handled in the renderer; still reserved so `chat.send` refuses it if it arrives.
    ("models", "Open model role settings"),
];

/// Filters the raw command list. Non-builtin (`file`/`skill`) commands are listed unpruned.
/// Builtins are shown only when verified, and then only with their verified subcommands.
pub(super) fn filter_supported_commands(raw: &[Value]) -> Vec<Value> {
    // Collected before pruning, so a file/skill command cannot shadow a dropped builtin.
    // Reserved names are seeded too, so a command that can never run is not listed.
    let mut builtin_claimed: std::collections::HashSet<&str> = std::collections::HashSet::new();
    builtin_claimed.extend(NATIVE_RESERVED_COMMANDS.iter().copied());
    // `switch` is always seeded, so a custom command cannot take its name.
    builtin_claimed.insert("switch");
    for command in raw {
        if !is_builtin_source(command.get("source").and_then(Value::as_str)) {
            continue;
        }
        if let Some(name) = command.get("name").and_then(Value::as_str) {
            builtin_claimed.insert(name);
        }
        if let Some(aliases) = command.get("aliases").and_then(Value::as_array) {
            for alias in aliases.iter().filter_map(Value::as_str) {
                builtin_claimed.insert(alias);
            }
        }
    }
    let mut out: Vec<Value> = NATIVE_BUILT_COMMANDS
        .iter()
        .map(|(name, description)| {
            json!({ "name": name, "description": description, "source": "native" })
        })
        .collect();
    for command in raw {
        let Some(name) = command.get("name").and_then(Value::as_str) else {
            continue;
        };
        let source = command.get("source").and_then(Value::as_str);
        if !is_builtin_source(source) {
            // A file/skill command sharing a name with any builtin is dropped entirely.
            let shadows_a_builtin = builtin_claimed.contains(name)
                || command
                    .get("aliases")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .any(|alias| builtin_claimed.contains(alias))
                    })
                    .unwrap_or(false);
            if shadows_a_builtin {
                continue;
            }
            out.push(command.clone());
            continue;
        }
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
        if name == "switch" {
            // `/model` is a menu-only alias of `/switch`; `ipc::chat` rewrites it before classifying.
            let mut aliases: Vec<Value> = pruned
                .get("aliases")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !aliases.iter().any(|a| a.as_str() == Some("model")) {
                aliases.push(Value::String("model".to_string()));
            }
            pruned["aliases"] = Value::Array(aliases);
        }
        out.push(pruned);
    }
    out
}

/// Splits a raw slash invocation into its name and remaining text.
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

/// A non-builtin descriptor takes free-form arguments; a builtin is limited to its verified subcommands.
pub enum SlashInvocationClassification {
    Supported,
    UnknownCommand,
    UnsupportedArguments,
}

/// A descriptor matches `name` either as its own `name` or one of its `aliases`.
fn matches_name(descriptor: &Value, name: &str) -> bool {
    descriptor.get("name").and_then(Value::as_str) == Some(name)
        || descriptor
            .get("aliases")
            .and_then(Value::as_array)
            .map(|a| a.iter().any(|v| v.as_str() == Some(name)))
            .unwrap_or(false)
}

/// The builtin check: the bare name or one verified subcommand, with no trailing text.
/// Shared by both branches of `classify_slash_invocation`.
fn classify_against_builtin(descriptor: &Value, rest: &str) -> SlashInvocationClassification {
    if descriptor.get("name").and_then(Value::as_str) == Some("switch") {
        // `/switch` takes one charset-checked model/role token, not a subcommand table.
        return if crate::session::model::model_support::is_switch_argument_token(rest) {
            SlashInvocationClassification::Supported
        } else {
            SlashInvocationClassification::UnsupportedArguments
        };
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

/// Resolves the descriptor `name` classifies against, preferring a builtin match. `None` if unknown.
/// Shared with `classify_unsupported_arguments` so a refusal uses the same descriptor.
fn resolve_matched_descriptor<'a>(name: &str, commands: &'a [Value]) -> Option<&'a Value> {
    commands
        .iter()
        .find(|c| {
            matches_name(c, name) && is_builtin_source(c.get("source").and_then(Value::as_str))
        })
        .or_else(|| commands.iter().find(|c| matches_name(c, name)))
}

pub fn classify_slash_invocation(
    name: &str,
    rest: &str,
    commands: &[Value],
) -> SlashInvocationClassification {
    let Some(descriptor) = resolve_matched_descriptor(name, commands) else {
        return SlashInvocationClassification::UnknownCommand;
    };
    if rest.is_empty() {
        return SlashInvocationClassification::Supported;
    }
    if !is_builtin_source(descriptor.get("source").and_then(Value::as_str)) {
        return SlashInvocationClassification::Supported;
    }
    classify_against_builtin(descriptor, rest)
}

/// Chooses the refusal wording: a valid subcommand followed by extra text, or an unrecognised word (#938).
pub enum SubcommandRefusal {
    ExtraTextAfterSubcommand { subcommand: String },
    UnrecognisedSubcommand { verified: Vec<String> },
}

/// Resolves the same descriptor the refusal used, so the listed options match what would be accepted.
pub fn classify_unsupported_arguments(
    name: &str,
    rest: &str,
    commands: &[Value],
) -> SubcommandRefusal {
    let verified: Vec<String> = resolve_matched_descriptor(name, commands)
        .and_then(|descriptor| descriptor.get("subcommands"))
        .and_then(Value::as_array)
        .map(|subs| {
            subs.iter()
                .filter_map(|s| s.get("name").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let sub_name = match rest.find(' ') {
        Some(idx) => &rest[..idx],
        None => rest,
    };
    if verified.iter().any(|v| v == sub_name) {
        SubcommandRefusal::ExtraTextAfterSubcommand {
            subcommand: sub_name.to_string(),
        }
    } else {
        SubcommandRefusal::UnrecognisedSubcommand { verified }
    }
}

#[cfg(test)]
#[path = "commands.test.rs"]
mod tests;
