// The reply shape for an OMP v19 `form` dialog: `data` keyed by control name.

use serde_json::Value;

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

#[cfg(test)]
#[path = "form_frame.test.rs"]
mod tests;
