// Slash-command filtering/classification tables (port of `slash-commands.ts`, plus the #760
// source-aware policy this build adds on top, lane R4 issue #787). See `mod.rs`'s own header
// for this module's place in the `agent/` split and the lane extension contract.

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
        // Issue #917, Decided (Stuart, 2026-10-16): deliberately included despite never being
        // probed (the probe's own DENYLIST names it, `omp-usage.md`'s "needs-decision" bucket) --
        // verified instead by issue #917's own live check against a real signed-in profile. Kept
        // in parity with `slash-commands.ts`'s own `SUPPORTED_OMP_COMMANDS`, which carries the
        // full rationale.
        "advisor" => Some(&["on", "off", "status"]),
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
        // Issue #762 (lane RM): the explicit decision `omp-usage.md` line 163 was waiting for.
        // No fixed subcommand table (an empty allow-list here, same shape `add-dir`/`dirs` use)
        // -- its one argument is a free-form, charset-checked model/role token, gated by
        // `classify_against_builtin`'s own name-aware branch below, never this table.
        "switch" => Some(&[]),
        _ => None,
    }
}

/// Issue #760 probe (FINDINGS item 57): OMP's own `source` field is `"builtin"` for its native
/// commands, `"file"` for a project/user command (the same value for both -- OMP does not
/// distinguish them further), and `"skill"` for a `/skill:<name>` entry. A command whose
/// `source` is anything OTHER than one of the two confirmed non-builtin values ("file"/"skill")
/// -- including a missing field entirely -- is treated as builtin-restricted: fail closed
/// towards the stricter, already-verified policy rather than trusting an unprobed future
/// `source` value with free-form arguments.
fn is_builtin_source(source: Option<&str>) -> bool {
    !matches!(source, Some("file") | Some("skill"))
}

/// Port of `src/shared/slash-commands.ts`'s own `NATIVE_RESERVED_COMMANDS`: Refract's own
/// native/reserved command names (constitution I), refused locally even if OMP later recognizes
/// one of them as a real command -- never forwarded as a literal prompt. `ipc::chat` imports
/// this (rather than keeping its own copy) so the one list backs both the send-time refusal and
/// the menu-filtering exclusion below.
pub const NATIVE_RESERVED_COMMANDS: &[&str] = &[
    "new",
    "resume",
    "plan",
    "fork",
    "settings",
    "pause",
    "plan-review",
    "btw",
    // Issue #762 (lane RM): `/model` is always rewritten to `/switch` before classification
    // (`ipc::chat`); reserved here too, defence in depth, so a future OMP command or a custom
    // command (#760) can never take the name over if that rewrite is ever bypassed.
    "model",
    // Issue #762: opens Settings' Model roles page client-side; never forwarded to OMP.
    "models",
    // Issue #766: `/role` with no argument has no server-side action (the renderer opens the
    // role selector); `/role <role>` is special-cased in `ipc::chat` BEFORE this check runs.
    "role",
];

/// Refract's own native commands (`NATIVE_BUILT_COMMANDS`): `/new` has a working implementation
/// (`start_new_conversation`); `/btw` is listed for menu parity with the Electron build but has
/// no implementation here (side chat out of scope, see `mod.rs`'s own header) -- `ipc::chat`'s
/// own `NATIVE_RESERVED_COMMANDS` check refuses it with `unknown-command` before classification
/// ever reaches `chat.send`, so this module never sees a `/btw` invocation to special-case.
/// Tagged `source: "native"` (issue #760's own `SlashCommandDescriptor.source` field) so the
/// menu can tell these apart from anything OMP itself reports.
const NATIVE_BUILT_COMMANDS: &[(&str, &str)] = &[
    ("new", "Start a new Conversation in this Session"),
    ("btw", "Ask the agent a side question"),
    // Gate-fix (HIGH): `role`/`models` are NOT listed here -- the renderer has no handler for
    // either yet (`MessageInput.tsx` only intercepts `btw`), so listing them would offer two
    // commands that always fail `unknown-command`, which contradicts this list's own "working
    // implementation" rule. They stay reserved (`NATIVE_RESERVED_COMMANDS` above) so a custom
    // command can never claim either name; add them here once the renderer half lands.
];

/// Port of `slash-commands.ts`'s own `filterSupportedCommands`, extended per issue #760: a
/// raw command whose `source` is NOT builtin (a project/user `"file"` command, or a `"skill"`)
/// is listed exactly as OMP reports it, with no allowlist pruning -- the user wrote it, so
/// `SUPPORTED_OMP_COMMANDS` (built-ins only, FR-032) does not apply. A builtin-sourced command
/// keeps today's rule: hidden entirely unless verified, then pruned to its verified subcommands.
pub(super) fn filter_supported_commands(raw: &[Value]) -> Vec<Value> {
    // Gate-fix (Medium, security): collected from the RAW list, before any allow-list pruning
    // below drops a builtin that was never verified (e.g. `model`, `login`) -- the bug this
    // closes let a file/skill command assume the identity of exactly that class of builtin,
    // because a downstream anti-shadow check that only sees the ALREADY-FILTERED list has no
    // trace left of a builtin this same function already dropped to compare against. Also
    // seeded with `NATIVE_RESERVED_COMMANDS` (gate-fix): a file/skill command named `plan`,
    // `resume`, etc. is refused unconditionally at `chat.send` regardless of source, so listing
    // it in the menu at all would be misleading -- it can never actually run.
    let mut builtin_claimed: std::collections::HashSet<&str> = std::collections::HashSet::new();
    builtin_claimed.extend(NATIVE_RESERVED_COMMANDS.iter().copied());
    // Gate-fix (MEDIUM, security): `switch` is a real OMP builtin this lane forwards (never
    // reserved, since it must still reach OMP) -- seeded unconditionally rather than only when
    // `raw` happens to report a builtin-sourced `switch` entry, so a custom command named
    // `switch` can never take the name over even against an OMP version/config that does not
    // list it as a builtin.
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
            // Gate-fix: a file/skill command whose name or alias is claimed by ANY raw
            // builtin-sourced entry -- allow-listed or not -- is dropped entirely: never
            // listed, never runnable. It must never be able to assume a builtin's identity.
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
            // Issue #762: `/model` is a Refract-side alias of `/switch`, menu display only --
            // `ipc::chat` rewrites a typed `/model` to `/switch` before anything is classified
            // or forwarded, so OMP's own descriptor (which has no `model` alias of its own)
            // never needs to be asked for this. "The menu lists one entry, /switch with the
            // alias model shown beside it, not two commands" (issue #762).
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

/// Port of `slash-commands.ts`'s own `SlashInvocationClassification`/`classifySlashInvocation`,
/// extended per issue #760: a non-builtin-sourced descriptor (project/user `"file"`, or
/// `"skill"`) runs with free-form arguments once its bare name is recognized -- only a builtin
/// descriptor stays restricted to its own verified subcommand table.
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

/// The builtin-restricted half of classification: the bare name/one verified subcommand only,
/// any further trailing text refused. Shared by both branches of `classify_slash_invocation`
/// below so the anti-shadow fix never duplicates this logic.
fn classify_against_builtin(descriptor: &Value, rest: &str) -> SlashInvocationClassification {
    if descriptor.get("name").and_then(Value::as_str) == Some("switch") {
        // Issue #762: `/switch` takes one charset-checked model/role token (`provider/id`, a
        // bare id, a thinking suffix, or a role alias `@role`), never OMP's own (absent)
        // `subcommands` table -- `supported_omp_subcommands`'s own `Some(&[])` entry for
        // `"switch"` exists only to keep it listed in the menu, not to gate this argument.
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

pub fn classify_slash_invocation(
    name: &str,
    rest: &str,
    commands: &[Value],
) -> SlashInvocationClassification {
    let Some(descriptor) = commands.iter().find(|c| matches_name(c, name)) else {
        return SlashInvocationClassification::UnknownCommand;
    };
    if rest.is_empty() {
        return SlashInvocationClassification::Supported;
    }
    // Gate-fix (High/Medium, security): a file/skill command sharing a NAME OR ALIAS with a
    // builtin must never inherit the free-form policy -- scan the WHOLE list for any
    // builtin-sourced entry matching `name` first, rather than trusting whichever single
    // descriptor `.find()` above happened to pick (OMP's own command-list ordering, not this
    // policy, would otherwise decide whether a shadowing custom command bypasses the denylist).
    let shadowed_builtin = commands.iter().find(|c| {
        matches_name(c, name) && is_builtin_source(c.get("source").and_then(Value::as_str))
    });
    if let Some(builtin_descriptor) = shadowed_builtin {
        return classify_against_builtin(builtin_descriptor, rest);
    }
    if !is_builtin_source(descriptor.get("source").and_then(Value::as_str)) {
        return SlashInvocationClassification::Supported;
    }
    classify_against_builtin(descriptor, rest)
}

#[cfg(test)]
#[path = "commands.test.rs"]
mod tests;
