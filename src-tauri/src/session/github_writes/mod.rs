// Detects `gh` writes (PRs and issues) in completed bash and eval tool calls; pure, no I/O.

use serde_json::Value;

mod gh_commands;
mod history;
mod shell_words;
#[cfg(test)]
mod tests;
pub(super) mod touched;

pub(super) use history::detect_in_history;

/// One completed tool call, from a live start/end frame pair or a saved history pair.
pub struct ToolCallRecord<'a> {
    /// `bash` or `eval`.
    pub tool: &'a str,
    /// bash: `{ command }`, eval: `{ code }`.
    pub args: &'a Value,
    /// Joined result text; a create prints the new item's URL here.
    pub output: &'a str,
    pub is_error: bool,
    pub at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteKind {
    Pr,
    Issue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteAction {
    Create,
    Merge,
    Close,
    Comment,
    Edit,
    ApiWrite,
}

/// One detected write. `repo` is `None` when the command named none (the Session's repo applies).
#[derive(Debug, Clone)]
pub struct GithubWrite {
    pub repo: Option<(String, String)>,
    pub kind: WriteKind,
    pub number: u64,
    pub action: WriteAction,
    pub at_ms: i64,
}

/// Empty for errors, reads and anything whose number cannot be resolved.
pub fn detect(call: &ToolCallRecord) -> Vec<GithubWrite> {
    if call.is_error {
        return Vec::new();
    }
    let commands: Vec<Vec<String>> = match call.tool {
        "bash" => match call.args.get("command").and_then(Value::as_str) {
            Some(command) => shell_words::split_commands(command),
            None => return Vec::new(),
        },
        "eval" => match call.args.get("code").and_then(Value::as_str) {
            Some(code) => shell_words::string_literals(code)
                .iter()
                .filter(|lit| lit.trim_start().starts_with("gh "))
                .flat_map(|lit| shell_words::split_commands(lit))
                .collect(),
            None => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    let urls = gh_commands::all_github_urls(call.output);
    let mut used = vec![false; urls.len()];
    let mut writes = Vec::new();
    for words in &commands {
        let Some(parsed) = gh_commands::parse(words) else {
            continue;
        };
        let (repo, number) = match parsed.number {
            Some(n) => (parsed.repo, n),
            None => {
                // Each unresolved command consumes the next unused output URL of its kind.
                let Some(index) = urls
                    .iter()
                    .enumerate()
                    .position(|(i, u)| !used[i] && u.2 == parsed.kind)
                else {
                    continue;
                };
                used[index] = true;
                let (owner, name, _, number) = urls[index].clone();
                (parsed.repo.or(Some((owner, name))), number)
            }
        };
        writes.push(GithubWrite {
            repo,
            kind: parsed.kind,
            number,
            action: parsed.action,
            at_ms: call.at_ms,
        });
    }
    writes
}

/// Joins the `text` parts of a tool result's `content` (or a plain string).
pub(super) fn join_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
