// `/skill:<name>` prompts (#1817): OMP delivers `role: "custom"`, `customType: "skill-prompt"`,
// `display: true`, `content` = the whole injected skill text, and `details` `{ name, path, args?,
// prompt?, lineCount }`. `details` carries no description, so the tooltip summary is read from the
// text itself (front-matter `description`, else the first body paragraph); this module does no I/O.

use serde_json::Value;

use super::TranscriptItem;

const SKILL_PROMPT_CUSTOM_TYPE: &str = "skill-prompt";
const SUMMARY_MAX_CHARS: usize = 280;

/// `None` (so the caller falls back to a Notice with the raw text) unless the message is a
/// displayed skill prompt whose `details.name` is a non-empty string.
pub(super) fn try_build_skill_prompt(
    message_id: &str,
    custom_type: &str,
    message: &Value,
) -> Option<TranscriptItem> {
    // FR-063 wants `attribution: "user"`; a message that omits it is still accepted rather than
    // regressing to the raw-text Notice if an OMP version drops the field.
    let agent_attributed = message
        .get("attribution")
        .and_then(Value::as_str)
        .is_some_and(|attribution| attribution != "user");
    if custom_type != SKILL_PROMPT_CUSTOM_TYPE
        || agent_attributed
        || message.get("display").and_then(Value::as_bool) != Some(true)
    {
        return None;
    }
    let details = message.get("details")?;
    let name = details
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())?;
    let text = message.get("content").and_then(Value::as_str).unwrap_or("");
    let args = details
        .get("args")
        .and_then(Value::as_str)
        .filter(|args| !args.trim().is_empty())
        .map(String::from);
    let line_count = details
        .get("lineCount")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    Some(TranscriptItem::SkillPrompt {
        id: message_id.to_string(),
        name: name.to_string(),
        args,
        line_count,
        description: summarize_skill_text(text),
        text: text.to_string(),
    })
}

/// The skill's own description: front-matter `description` when the text still carries the
/// front matter (older OMP), else the first prose paragraph of the body.
fn summarize_skill_text(text: &str) -> Option<String> {
    // The text opens with an `[IMPORTANT: ...]` line, then a blank line, then the skill file.
    let skill = text.split_once("\n\n").map_or("", |(_, rest)| rest);
    let skill = skill.trim_start_matches(['\r', '\n']);
    let summary = match front_matter_split(skill) {
        Some((front, body)) => front_matter_description(front).or_else(|| first_paragraph(body)),
        None => first_paragraph(skill),
    }?;
    Some(truncate_chars(&summary, SUMMARY_MAX_CHARS))
}

/// `(front matter, body)` when `skill` opens with a `---` fenced block.
fn front_matter_split(skill: &str) -> Option<(&str, &str)> {
    let rest = skill
        .strip_prefix("---\r\n")
        .or_else(|| skill.strip_prefix("---\n"))?;
    let end = rest
        .match_indices("---")
        .map(|(i, _)| i)
        .find(|&i| i == 0 || rest[..i].ends_with('\n'))?;
    Some((
        &rest[..end],
        rest[end + 3..].trim_start_matches(['\r', '\n']),
    ))
}

/// A one-line `description: ...` (optionally quoted) or a `>`/`|` block scalar.
fn front_matter_description(front: &str) -> Option<String> {
    let mut lines = front.lines();
    let value = lines
        .find_map(|line| line.strip_prefix("description:"))?
        .trim();
    let joined = if matches!(value.chars().next(), Some('>' | '|')) {
        lines
            .take_while(|line| line.starts_with([' ', '\t']))
            .map(str::trim)
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        unquote(value).to_string()
    };
    let joined = joined.trim();
    (!joined.is_empty()).then(|| joined.to_string())
}

fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
            .filter(|inner| !inner.contains(quote))
        {
            return inner;
        }
    }
    value
}

/// First run of prose lines: headings, rules and the trailing `[Skill directory: ...]` footer
/// are not a summary.
fn first_paragraph(body: &str) -> Option<String> {
    let mut paragraph: Vec<&str> = Vec::new();
    for line in body.lines().map(str::trim) {
        let skippable =
            line.starts_with('#') || line == "---" || line.starts_with("[Skill directory:");
        if line.is_empty() || skippable {
            if !paragraph.is_empty() {
                break;
            }
            if line.starts_with("[Skill directory:") {
                return None;
            }
            continue;
        }
        paragraph.push(line);
    }
    (!paragraph.is_empty()).then(|| paragraph.join(" "))
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}\u{2026}", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::super::TranscriptState;
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../tests/fixtures/skill-prompt.json")).unwrap()
    }

    fn only_wire(state: &TranscriptState) -> Value {
        assert_eq!(state.items().len(), 1);
        serde_json::to_value(&*state.items()[0]).unwrap()
    }

    #[test]
    fn live_shape_becomes_a_skill_prompt_row_with_a_body_summary() {
        let mut state = TranscriptState::new();
        state.apply_frame(&fixture()["liveFrame"], false);
        let wire = only_wire(&state);
        assert_eq!(wire["kind"], "skill-prompt");
        assert_eq!(wire["id"], "msg-skill-live");
        assert_eq!(wire["name"], "check-build");
        assert_eq!(wire["args"], "monitor build 9681");
        assert_eq!(wire["lineCount"], 132);
        // The 2026-11 text has no front matter, so the summary is the first body paragraph.
        assert!(wire["description"]
            .as_str()
            .unwrap()
            .starts_with("Fetch a single Azure DevOps build by id"));
        assert!(wire["text"].as_str().unwrap().contains("check-build"));
    }

    #[test]
    fn replay_shape_uses_the_front_matter_description_and_omits_missing_args() {
        let state = TranscriptState::from_history(&[fixture()["replay"].clone()]);
        let wire = only_wire(&state);
        assert_eq!(wire["kind"], "skill-prompt");
        assert_eq!(wire["id"], "h0");
        assert_eq!(wire["name"], "handoff");
        assert!(wire.get("args").is_none());
        assert!(wire["description"]
            .as_str()
            .unwrap()
            .starts_with("Compact the current session into a short handoff note"));
    }

    #[test]
    fn message_without_a_name_falls_back_to_the_notice_row() {
        let mut message = fixture()["replay"].clone();
        message["details"] = json!({ "lineCount": 3 });
        let state = TranscriptState::from_history(&[message.clone()]);
        let wire = only_wire(&state);
        assert_eq!(wire["kind"], "notice");
        assert_eq!(wire["text"], message["content"]);
    }

    #[test]
    fn undisplayed_skill_prompt_stays_hidden() {
        let mut message = fixture()["replay"].clone();
        message["display"] = json!(false);
        assert!(TranscriptState::from_history(&[message]).items().is_empty());
    }

    #[test]
    fn summary_handles_block_scalars_quotes_and_missing_text() {
        let block = "[IMPORTANT: x]\n\n---\nname: a\ndescription: >\n  one\n  two\nuser-invocable: true\n---\n\n# A\n\nBody.";
        assert_eq!(summarize_skill_text(block).as_deref(), Some("one two"));
        let quoted = "[IMPORTANT: x]\n\n---\ndescription: \"Quoted: yes\"\n---\n\nBody.";
        assert_eq!(summarize_skill_text(quoted).as_deref(), Some("Quoted: yes"));
        let no_description =
            "[IMPORTANT: x]\n\n---\nname: a\n---\n\n# A\n\nFirst line\nsecond line.\n\nLater.";
        assert_eq!(
            summarize_skill_text(no_description).as_deref(),
            Some("First line second line.")
        );
        let footer_only = "[IMPORTANT: x]\n\n[Skill directory: C:\\s]\nResolve paths.";
        assert_eq!(summarize_skill_text(footer_only), None);
        assert_eq!(summarize_skill_text(""), None);
    }

    #[test]
    fn long_summary_is_truncated_on_a_char_boundary() {
        let text = format!("[IMPORTANT: x]\n\n{}", "é".repeat(400));
        let summary = summarize_skill_text(&text).unwrap();
        assert_eq!(summary.chars().count(), SUMMARY_MAX_CHARS);
        assert!(summary.ends_with('\u{2026}'));
    }
}
