// `repositories.setColor`: sets or clears the Project colour. Kept apart from `repositories.rs` (#806).
// `color` is a known preset id or `#RGB`/`#RRGGBB` hex.

use serde_json::Value;

use crate::store::registry::ProjectColor;

use super::{arg_str, invalid_argument, map_registry_error, AppState, Dispatcher, HandlerFuture};

/// The ten preset ids, matching the renderer's `--project-1` to `--project-10` tokens.
pub const PRESET_IDS: [&str; 10] = [
    "lime", "teal", "cyan", "blue", "indigo", "violet", "magenta", "pink", "slate", "sand",
];

pub fn register(d: &mut Dispatcher) {
    d.register("repositories.setColor", repositories_set_color);
}

/// `#RGB` or `#RRGGBB` only.
fn is_valid_hex(hex: &str) -> bool {
    let digits = match hex.strip_prefix('#') {
        Some(digits) => digits,
        None => return false,
    };
    (digits.len() == 3 || digits.len() == 6) && digits.chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_color(value: &Value) -> Result<Option<ProjectColor>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let kind = value.get("kind").and_then(Value::as_str);
    match kind {
        Some("preset") => {
            let id = value.get("id").and_then(Value::as_str).unwrap_or("");
            if PRESET_IDS.contains(&id) {
                Ok(Some(ProjectColor::Preset { id: id.to_string() }))
            } else {
                Err("repositories.setColor unknown preset id".to_string())
            }
        }
        Some("custom") => {
            let hex = value.get("hex").and_then(Value::as_str).unwrap_or("");
            if is_valid_hex(hex) {
                Ok(Some(ProjectColor::Custom {
                    hex: hex.to_string(),
                }))
            } else {
                Err("repositories.setColor hex must be #RGB or #RRGGBB".to_string())
            }
        }
        _ => Err("repositories.setColor expects (id, color | null)".to_string()),
    }
}

/// Returns the plain registry shape; the renderer merges its own remote back in.
pub fn repositories_set_color(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "repositories.setColor expects (id, color | null)",
                ))
            }
        };
        let color = parse_color(args.get(1).unwrap_or(&Value::Null)).map_err(invalid_argument)?;
        let updated = state
            .registry
            .lock()
            .await
            .update_repository_color(&id, color)
            .await
            .map_err(map_registry_error)?;
        state.session_manager.notify_list_changed();
        Ok(serde_json::to_value(&updated).expect("Repository is always JSON-serialisable"))
    })
}
