// Default answers for an OMP `form` dialog, so Away Mode can submit it with nobody there to fill it.
// A small tolerant tokenizer, not a validator: OMP checks the submitted data itself.

use std::collections::HashMap;

use serde_json::{json, Map, Number, Value};

use super::away::{safe_position, ASK_FALLBACK};

/// Matches the key cap `validate_form_data` enforces on a submission.
const MAX_FIELDS: usize = 100;
/// A form is a few KiB; the cap keeps a hostile one from costing a long scan.
const MAX_HTML_BYTES: usize = 256 * 1024;
/// Per choice group, so the duplicate check stays cheap on a huge list.
const MAX_CHOICES: usize = 1000;

struct Tag {
    name: String,
    attrs: Vec<(String, String)>,
}

impl Tag {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    fn has(&self, key: &str) -> bool {
        self.attr(key).is_some()
    }
}

enum Event {
    Open(Tag),
    Close(String),
    Text(String),
}

struct Choice {
    value: String,
    /// The text a person reads for it; empty when the control has none.
    label: String,
    checked: bool,
    disabled: bool,
    /// A pre-checked checkbox stays ticked only when the form marks it required; options and radios
    /// have no such gate.
    keeps_check: bool,
}

impl Choice {
    fn text(&self) -> &str {
        if self.label.is_empty() {
            &self.value
        } else {
            &self.label
        }
    }
}

enum Field {
    Value(String, Value),
    Group {
        name: String,
        radio: bool,
        choices: Vec<Choice>,
    },
}

fn decode(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// The tag body up to its closing `>`, ignoring a `>` inside quotes, and what follows it.
fn split_tag(rest: &str) -> (&str, &str) {
    let mut quote: Option<char> = None;
    for (i, c) in rest.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => quote = Some(c),
            (None, '>') => return (&rest[..i], &rest[i + 1..]),
            _ => {}
        }
    }
    (rest, "")
}

fn parse_attrs(mut body: &str) -> Vec<(String, String)> {
    let mut attrs = Vec::new();
    loop {
        body = body.trim_start_matches(|c: char| c.is_whitespace() || c == '/');
        let end = body
            .find(|c: char| c.is_whitespace() || c == '=' || c == '/')
            .unwrap_or(body.len());
        if end == 0 {
            break;
        }
        let key = body[..end].to_ascii_lowercase();
        body = body[end..].trim_start();
        let mut value = String::new();
        if let Some(after) = body.strip_prefix('=') {
            body = after.trim_start();
            let first = body.chars().next();
            if let Some(q @ ('"' | '\'')) = first {
                let inner = &body[1..];
                let close = inner.find(q).unwrap_or(inner.len());
                value = decode(&inner[..close]);
                body = inner.get(close + 1..).unwrap_or("");
            } else {
                let stop = body.find(char::is_whitespace).unwrap_or(body.len());
                value = decode(&body[..stop]);
                body = &body[stop..];
            }
        }
        attrs.push((key, value));
    }
    attrs
}

fn tokenize(html: &str) -> Vec<Event> {
    let mut events = Vec::new();
    let mut rest = html;
    while !rest.is_empty() {
        let Some(start) = rest.find('<') else {
            events.push(Event::Text(decode(rest)));
            break;
        };
        if start > 0 {
            events.push(Event::Text(decode(&rest[..start])));
        }
        rest = &rest[start..];
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = after.find("-->").map_or("", |end| &after[end + 3..]);
            continue;
        }
        let next = rest[1..].chars().next();
        if !matches!(next, Some(c) if c.is_ascii_alphabetic() || c == '/') {
            events.push(Event::Text("<".to_string()));
            rest = &rest[1..];
            continue;
        }
        let (body, tail) = split_tag(&rest[1..]);
        rest = tail;
        if let Some(closing) = body.strip_prefix('/') {
            events.push(Event::Close(closing.trim().to_ascii_lowercase()));
            continue;
        }
        let name_end = body
            .find(|c: char| c.is_whitespace() || c == '/')
            .unwrap_or(body.len());
        events.push(Event::Open(Tag {
            name: body[..name_end].to_ascii_lowercase(),
            attrs: parse_attrs(&body[name_end..]),
        }));
    }
    events
}

fn text_at(events: &[Event], at: usize) -> &str {
    match events.get(at) {
        Some(Event::Text(text)) => text.trim(),
        _ => "",
    }
}

fn number(raw: &str) -> Option<Value> {
    let raw = raw.trim();
    if let Ok(whole) = raw.parse::<i64>() {
        return Some(json!(whole));
    }
    raw.parse::<f64>()
        .ok()
        .and_then(Number::from_f64)
        .map(Value::Number)
}

fn text_or_fallback(text: &str) -> Value {
    json!(if text.trim().is_empty() {
        ASK_FALLBACK
    } else {
        text
    })
}

/// A single-choice field takes its marked choice, else the safe (negative) one, else the first, among
/// the enabled ones. A multi-choice field submits only checked choices the form marks required: it
/// never ticks boxes on the user's behalf, and an empty one is left out.
fn pick(choices: &[Choice], many: bool) -> Option<Value> {
    let enabled: Vec<&Choice> = choices.iter().filter(|c| !c.disabled).collect();
    let picked: Vec<&str> = if many {
        enabled
            .iter()
            .filter(|c| c.checked && c.keeps_check)
            .map(|c| c.value.as_str())
            .collect()
    } else if let Some(marked) = enabled.iter().rev().find(|c| c.checked) {
        vec![marked.value.as_str()]
    } else {
        safe_position(enabled.iter().map(|c| c.text()))
            .map(|i| vec![enabled[i].value.as_str()])
            .unwrap_or_default()
    };
    let first = *picked.first()?;
    Some(if many && choices.len() > 1 {
        json!(picked)
    } else {
        json!(first)
    })
}

fn read_input(
    tag: &Tag,
    trailing: &str,
    fields: &mut Vec<Field>,
    groups: &mut HashMap<(String, bool), usize>,
) {
    let kind = tag
        .attr("type")
        .unwrap_or("text")
        .trim()
        .to_ascii_lowercase();
    let Some(name) = tag.attr("name").map(str::trim).filter(|n| !n.is_empty()) else {
        return;
    };
    let value = tag.attr("value").unwrap_or("");
    match kind.as_str() {
        "hidden" | "submit" | "button" | "reset" | "image" => {}
        "radio" | "checkbox" => {
            let radio = kind == "radio";
            let value = if value.is_empty() { trailing } else { value };
            if value.is_empty() {
                return;
            }
            let choice = Choice {
                value: value.to_string(),
                label: trailing.to_string(),
                checked: tag.has("checked"),
                disabled: tag.has("disabled"),
                keeps_check: radio || tag.has("required"),
            };
            match groups.get(&(name.to_string(), radio)) {
                Some(&index) => {
                    if let Field::Group { choices, .. } = &mut fields[index] {
                        if choices.len() < MAX_CHOICES
                            && !choices.iter().any(|c| c.value == choice.value)
                        {
                            choices.push(choice);
                        }
                    }
                }
                None => {
                    groups.insert((name.to_string(), radio), fields.len());
                    fields.push(Field::Group {
                        name: name.to_string(),
                        radio,
                        choices: vec![choice],
                    });
                }
            }
        }
        "number" | "range" => {
            let fallback = tag.attr("min").unwrap_or("0");
            let picked = number(value)
                .or_else(|| number(fallback))
                .unwrap_or(json!(0));
            fields.push(Field::Value(name.to_string(), picked));
        }
        // An address or URL the agent would reject is worse than leaving the field out.
        "email" | "url" => {
            if !value.trim().is_empty() {
                fields.push(Field::Value(name.to_string(), json!(value)));
            }
        }
        _ => fields.push(Field::Value(name.to_string(), text_or_fallback(value))),
    }
}

/// Reads a `<select>` whose tag sits just before `from`; returns where the scan resumes.
fn read_select(tag: &Tag, events: &[Event], from: usize, fields: &mut Vec<Field>) -> usize {
    let mut choices: Vec<Choice> = Vec::new();
    let mut at = from;
    while at < events.len() {
        match &events[at] {
            Event::Close(name) if name == "select" => {
                at += 1;
                break;
            }
            Event::Open(option) if option.name == "option" => {
                let label = text_at(events, at + 1);
                let value = option.attr("value").unwrap_or(label);
                if choices.len() < MAX_CHOICES && !choices.iter().any(|c| c.value == value) {
                    choices.push(Choice {
                        value: value.to_string(),
                        label: label.to_string(),
                        checked: option.has("selected"),
                        disabled: option.has("disabled"),
                        keeps_check: true,
                    });
                }
            }
            _ => {}
        }
        at += 1;
    }
    let name = tag.attr("name").map(str::trim).unwrap_or("");
    if name.is_empty() {
        return at;
    }
    if let Some(picked) = pick(&choices, tag.has("multiple")) {
        fields.push(Field::Value(name.to_string(), picked));
    }
    at
}

/// The longest prefix of `html` within `MAX_HTML_BYTES`, cut on a character boundary.
fn capped(html: &str) -> &str {
    let mut end = html.len().min(MAX_HTML_BYTES);
    while !html.is_char_boundary(end) {
        end -= 1;
    }
    &html[..end]
}

/// The `data` object Away Mode submits: the safe (negative) option of each choice field, else its
/// first, and the Away fallback text for an empty text field. Controls without a `name` are left out,
/// as a submit would. Only the first `MAX_HTML_BYTES` of the form and `MAX_FIELDS` fields are read.
pub fn form_defaults(html: &str) -> Value {
    let events = tokenize(capped(html));
    let mut fields: Vec<Field> = Vec::new();
    let mut groups: HashMap<(String, bool), usize> = HashMap::new();
    let mut at = 0;
    while at < events.len() && fields.len() < MAX_FIELDS {
        let Event::Open(tag) = &events[at] else {
            at += 1;
            continue;
        };
        at += 1;
        match tag.name.as_str() {
            "input" => read_input(tag, text_at(&events, at), &mut fields, &mut groups),
            "textarea" => {
                if let Some(name) = tag.attr("name").map(str::trim).filter(|n| !n.is_empty()) {
                    let body = match events.get(at) {
                        Some(Event::Text(text)) => text.as_str(),
                        _ => "",
                    };
                    fields.push(Field::Value(name.to_string(), text_or_fallback(body)));
                }
            }
            "select" => at = read_select(tag, &events, at, &mut fields),
            _ => {}
        }
    }
    let mut data = Map::new();
    for field in fields {
        let (name, value) = match field {
            Field::Value(name, value) => (name, Some(value)),
            Field::Group {
                name,
                radio,
                choices,
            } => (name, pick(&choices, !radio)),
        };
        if let Some(value) = value {
            data.insert(name, value);
        }
    }
    Value::Object(data)
}

#[cfg(test)]
#[path = "away_form.test.rs"]
mod tests;
