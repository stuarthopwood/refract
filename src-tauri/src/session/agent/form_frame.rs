// The reply shape for an OMP v19 `form` dialog: `data` keyed by control name.

use serde_json::{json, Value};

/// OMP's `parseFormDialogResponse` throws on a value that is not a string, a number, or an array of
/// strings, so a bad payload is refused here instead of reaching it.
pub(super) fn validate_form_data(data: &Value) -> Result<(), String> {
    let fields = data
        .as_object()
        .ok_or_else(|| "form data must be an object".to_string())?;
    for (name, value) in fields {
        let valid = match value {
            Value::String(_) | Value::Number(_) => true,
            Value::Array(items) => items.iter().all(Value::is_string),
            _ => false,
        };
        if !valid {
            return Err(format!(
                "form field {name} must be a string, a number, or an array of strings"
            ));
        }
    }
    Ok(())
}

/// The `extension_ui_response` for a form: its `data`, or a cancel that says so when the deadline fired.
pub(super) fn build_form_response(request_id: &str, answer: &Value) -> Result<Value, String> {
    if answer.get("cancelled") == Some(&Value::Bool(true)) {
        let mut reply =
            json!({ "type": "extension_ui_response", "id": request_id, "cancelled": true });
        if answer.get("timedOut") == Some(&Value::Bool(true)) {
            reply["timedOut"] = Value::Bool(true);
        }
        return Ok(reply);
    }
    let data = answer
        .get("data")
        .ok_or_else(|| format!("expected a data object for form request {request_id}"))?;
    validate_form_data(data).map_err(|err| format!("{err} (form request {request_id})"))?;
    Ok(json!({ "type": "extension_ui_response", "id": request_id, "data": data.clone() }))
}

#[cfg(test)]
#[path = "form_frame.test.rs"]
mod tests;
