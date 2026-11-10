// The panel-action contract, embedded so Rust and the renderer read one declaration (spec 124).

use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{json, Value};

const CONTRACT_JSON: &str =
    include_str!("../../../specs/124-tool-channel-1193/contracts/panel-actions.json");

#[derive(Debug, Deserialize)]
pub struct Contract {
    pub panels: Vec<Panel>,
}

#[derive(Debug, Deserialize)]
pub struct Panel {
    pub id: String,
    #[serde(default, rename = "openInputSchema")]
    pub open_input_schema: Option<Value>,
    pub actions: Vec<Action>,
}

#[derive(Debug, Deserialize)]
pub struct Action {
    pub name: String,
    pub mutates: bool,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

static CONTRACT: LazyLock<Contract> = LazyLock::new(|| {
    serde_json::from_str(CONTRACT_JSON).expect("panel-actions.json is valid and embedded")
});

pub fn contract() -> &'static Contract {
    &CONTRACT
}

pub fn panel(id: &str) -> Option<&'static Panel> {
    contract().panels.iter().find(|p| p.id == id)
}

pub fn action(panel_id: &str, name: &str) -> Option<&'static Action> {
    panel(panel_id)?.actions.iter().find(|a| a.name == name)
}

/// `None` when the panel or action is not declared, so callers cannot treat unknown as safe.
pub fn is_mutating(panel_id: &str, action_name: &str) -> Option<bool> {
    action(panel_id, action_name).map(|a| a.mutates)
}

pub fn panel_ids() -> Vec<&'static str> {
    contract().panels.iter().map(|p| p.id.as_str()).collect()
}

pub const LIST_PANELS: &str = "refract_list_panels";
pub const OPEN_PANEL: &str = "refract_open_panel";
pub const INVOKE_PANEL_ACTION: &str = "refract_invoke_panel_action";

/// The `parameters` schema omp shows the model for a tool.
pub fn tool_parameters(tool: &str) -> Value {
    match tool {
        OPEN_PANEL => json!({
            "type": "object",
            "properties": {
                "panelId": { "type": "string", "enum": panel_ids(), "description": "Panel id from refract_list_panels." },
                "input": { "type": "object", "description": "Optional panel-specific open input, as listed by refract_list_panels." }
            },
            "required": ["panelId"],
            "additionalProperties": false
        }),
        INVOKE_PANEL_ACTION => json!({
            "type": "object",
            "properties": {
                "panelId": { "type": "string", "enum": panel_ids(), "description": "Panel id from refract_list_panels." },
                "action": { "type": "string", "description": "Action name from refract_list_panels." },
                "input": { "type": "object", "description": "Action input matching that action's inputSchema." }
            },
            "required": ["panelId", "action"],
            "additionalProperties": false
        }),
        _ => json!({ "type": "object", "properties": {}, "additionalProperties": false }),
    }
}

pub fn tool_description(tool: &str) -> &'static str {
    match tool {
        LIST_PANELS => "List Refract's right-pane panels with their actions and whether each is available.",
        OPEN_PANEL => "Open a Refract right-pane panel for the developer without moving their keyboard focus.",
        INVOKE_PANEL_ACTION => "Run a declared action on a Refract right-pane panel. Actions that change files ask the developer first.",
        _ => "",
    }
}

fn type_matches(kind: &str, value: &Value) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        _ => true,
    }
}

/// A worktree-relative path: not empty, not rooted, no `..` segment, no drive prefix.
fn is_relative_path(path: &str) -> bool {
    if path.is_empty() || path.starts_with(['/', '\\']) || path.contains('\0') {
        return false;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    !path.split(['/', '\\']).any(|segment| segment == "..")
}

/// Hand check of `type`, `required`, `properties`, `additionalProperties:false`, `enum` and
/// `minimum`; the `jsonschema` crate is not a dependency. Properties named `path` must be
/// worktree-relative (FR-017).
pub fn validate(schema: &Value, value: &Value, at: &str) -> Result<(), String> {
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        if !type_matches(kind, value) {
            return Err(format!("{at} must be of type {kind}"));
        }
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            return Err(format!("{at} is not one of the allowed values"));
        }
    }
    if let (Some(min), Some(n)) = (
        schema.get("minimum").and_then(Value::as_f64),
        value.as_f64(),
    ) {
        if n < min {
            return Err(format!("{at} must be at least {min}"));
        }
    }
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let properties = schema.get("properties").and_then(Value::as_object);
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(key) {
                return Err(format!("{at}.{key} is required"));
            }
        }
    }
    for (key, item) in object {
        let child = format!("{at}.{key}");
        match properties.and_then(|p| p.get(key)) {
            Some(child_schema) => validate(child_schema, item, &child)?,
            None if schema.get("additionalProperties") == Some(&Value::Bool(false)) => {
                return Err(format!("{child} is not allowed"));
            }
            None => {}
        }
        if key == "path" {
            if let Some(path) = item.as_str() {
                if !is_relative_path(path) {
                    return Err(format!("{child} must be a worktree-relative path"));
                }
            }
        }
    }
    Ok(())
}

/// The call's own arguments: an object using only `allowed` keys.
pub fn validate_keys(args: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = args
        .as_object()
        .ok_or_else(|| "arguments must be an object".to_string())?;
    match object.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(key) => Err(format!("arguments.{key} is not allowed")),
        None => Ok(()),
    }
}

#[cfg(test)]
#[path = "panels.test.rs"]
mod tests;
