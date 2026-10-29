// `repositories.setColor` (issue #887): sets or clears the Project colour shown on a Project's
// Session list header. Kept apart from `repositories.rs`, which sits near the 600-line cap
// (#806). The renderer sends `(id, color | null)`; `color` is `{ kind: 'preset', id }` with one
// of the ten known preset ids, or `{ kind: 'custom', hex }` with `#RGB` or `#RRGGBB`.

use serde_json::Value;

use crate::store::registry::{ProjectColor, Repository};

use super::{
    arg_str, invalid_argument, map_registry_error, not_found, AppState, Dispatcher, HandlerFuture,
};

/// The ten preset ids, in the order of the renderer's `--project-1` to `--project-10` tokens.
pub const PRESET_IDS: [&str; 10] = [
    "lime", "teal", "cyan", "blue", "indigo", "violet", "magenta", "pink", "slate", "sand",
];

pub fn register(d: &mut Dispatcher) {
    d.register("repositories.setColor", repositories_set_color);
}

/// `#RGB` or `#RRGGBB` only: no alpha, no named colours, no CSS functions.
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

/// `Repository` carries no `remote`; the renderer merges its own known remote back in, so this
/// returns the plain registry shape.
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
        let existing: Repository = {
            let registry = state.registry.lock().await;
            registry
                .get_repository(&id)
                .ok_or_else(|| not_found(format!("Repository not found: {id}")))?
                .clone()
        };
        let updated = state
            .registry
            .lock()
            .await
            .update_repository_color(&existing.id, color)
            .await
            .map_err(map_registry_error)?;
        state.session_manager.notify_list_changed();
        Ok(serde_json::to_value(&updated).expect("Repository is always JSON-serialisable"))
    })
}
