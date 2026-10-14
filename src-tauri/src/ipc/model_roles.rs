// IPC handlers for `modelRoles.*` (lane R8, issue #791; issue #455 originally). Thin wrapper
// over `omp::config`'s generic engine (#691) -- no `SettingsStore`/`SessionManager` dependency at
// all, since model roles live in OMP's own global config, not Refract's `settings.json`. Also
// owns the model-roles-specific business logic `src/main/omp/config.ts` keeps alongside its own
// generic engine (read-merge-write, selector validation, catalog-row parsing): split into this
// file, rather than `omp/config.rs`, only to keep that file's generic engine under this build's
// 600-line-per-file cap -- every function below is still a direct, faithful port of its
// `config.ts` namesake.

use std::collections::HashMap;

use serde_json::{Map, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::omp::config::{get_config, set_config, OmpConfigError, OmpConfigErrorCode};

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

const MODEL_ROLE_IDS: [&str; 15] = [
    "default",
    "smol",
    "slow",
    "vision",
    "plan",
    "commit",
    "tiny",
    "memory",
    "task",
    "advisor",
    "image",
    "web",
    "speech",
    "dictation",
    "judge",
];
const CATALOG_KINDS: [&str; 7] = ["chat", "tiny", "image", "tts", "stt", "search", "judge"];

fn is_model_role_id(value: &str) -> bool {
    MODEL_ROLE_IDS.contains(&value)
}

fn is_catalog_kind(value: &str) -> bool {
    CATALOG_KINDS.contains(&value)
}

pub fn register(d: &mut Dispatcher) {
    d.register("modelRoles.list", model_roles_list);
    d.register("modelRoles.set", model_roles_set);
    d.register("modelRoles.listCatalog", model_roles_list_catalog);
}

/// Maps an `OmpConfigError` to the `IpcErrorCode` vocabulary `ipc/accounts.rs` already
/// established for an `omp` CLI call that failed. Exported for direct unit testing.
pub fn to_ipc_error(err: &OmpConfigError) -> IpcError {
    match err.code {
        OmpConfigErrorCode::Timeout => IpcError::new("timeout", err.message.clone()),
        OmpConfigErrorCode::InvalidValue => IpcError::new("invalid-argument", err.message.clone()),
        _ => IpcError::new("omp-probe-failed", err.message.clone()),
    }
}

#[derive(Debug, Clone)]
pub struct SetModelRoleResult {
    pub roles: HashMap<String, String>,
    pub overridden_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ModelCatalogEntry {
    pub provider: String,
    pub id: String,
    pub selector: String,
    pub name: String,
}

/// Security-audit finding (unconfirmed-but-defended, FINDINGS item 48's "env override probe"):
/// stripped from both the merge-read and the `config set` call so a runtime role override never
/// folds into what this module reads back as the persisted baseline. The public, display-only
/// `get_model_roles` deliberately does NOT strip these.
const ROLE_OVERRIDE_ENV_VARS: [&str; 4] = [
    "PI_SMOL_MODEL",
    "PI_SLOW_MODEL",
    "PI_PLAN_MODEL",
    "PI_CONFIG_FILES",
];

/// Case-insensitive (Windows environment variable names are case-insensitive). Exported for
/// direct unit testing.
pub fn env_without_role_overrides(env: &HashMap<String, String>) -> HashMap<String, String> {
    env.iter()
        .filter(|(key, _)| {
            !ROLE_OVERRIDE_ENV_VARS
                .iter()
                .any(|stripped| stripped.eq_ignore_ascii_case(key))
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn current_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

/// Validates that `value` is a plain, non-array object (the shape `omp config get/set modelRoles`
/// always returns), returning a shallow copy. `Value::Null` is an empty record. Exported for
/// direct unit testing.
pub fn raw_model_roles_record(value: &Value) -> Result<Map<String, Value>, OmpConfigError> {
    match value {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        _ => Err(OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp config returned a non-record modelRoles value.",
        )),
    }
}

/// Narrows a raw modelRoles record to the string-only view the renderer understands; a blank
/// (empty-after-trim) string entry is dropped too (a11y: never shown as "Inherited" with no
/// visible text). Exported for direct unit testing.
pub fn string_entries_only(record: &Map<String, Value>) -> HashMap<String, String> {
    record
        .iter()
        .filter_map(|(key, entry)| match entry {
            Value::String(text) if !text.trim().is_empty() => Some((key.clone(), text.clone())),
            _ => None,
        })
        .collect()
}

/// Pure merge step: applies one role change without touching any other key, without mutating
/// `current`. Returns `None` when clearing a role that was already absent (the caller skips a
/// needless `omp config set`). Exported for direct unit testing.
pub fn merge_model_role(
    current: &Map<String, Value>,
    role: &str,
    value: Option<&str>,
) -> Option<Map<String, Value>> {
    match value {
        None => {
            if !current.contains_key(role) {
                return None;
            }
            let mut next = current.clone();
            next.remove(role);
            Some(next)
        }
        Some(selector) => {
            let mut next = current.clone();
            next.insert(role.to_string(), Value::String(selector.to_string()));
            Some(next)
        }
    }
}

async fn read_model_roles_raw(
    env_override: Option<&HashMap<String, String>>,
) -> Result<Map<String, Value>, OmpConfigError> {
    let response = get_config("modelRoles", env_override).await?;
    let inner = response.get("value").cloned().unwrap_or(Value::Null);
    raw_model_roles_record(&inner)
}

/// `omp config get modelRoles --json`: the whole record as the TRUE effective value (environment
/// overrides included -- for display, not for merging-before-write).
pub async fn get_model_roles() -> Result<HashMap<String, String>, OmpConfigError> {
    let raw = read_model_roles_raw(None).await?;
    Ok(string_entries_only(&raw))
}

const MAX_ROLE_VALUE_LENGTH: usize = 512;

// Widened past C0 controls and DEL to also cover C1 controls (U+0080-U+009F), the line/paragraph
// separators (U+2028/U+2029), and the bidi/zero-width/BOM range (U+200B-U+200F, U+202A-U+202E,
// U+2066-U+2069, U+FEFF).
fn is_forbidden_selector_char(c: char) -> bool {
    matches!(c as u32, 0x00..=0x1F | 0x7F..=0x9F | 0x200B..=0x200F | 0x2028..=0x202E | 0x2066..=0x2069)
        || c == '\u{FEFF}'
}

/// Exported for direct unit testing.
pub fn assert_valid_selector(value: &str) -> Result<(), OmpConfigError> {
    if value.trim().is_empty() {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::InvalidValue,
            "Model selector cannot be blank.",
        ));
    }
    if value.chars().count() > MAX_ROLE_VALUE_LENGTH {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::InvalidValue,
            format!("Model selector is too long (max {MAX_ROLE_VALUE_LENGTH} characters)."),
        ));
    }
    if value.chars().any(is_forbidden_selector_char) {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::InvalidValue,
            "Model selector contains control or formatting characters.",
        ));
    }
    Ok(())
}

/// Serialises the whole read-merge-write (not just the final write) so two near-simultaneous role
/// edits never race each other into a lost update -- mirrors `config.ts`'s own `enqueueWrite`.
static MODEL_ROLES_WRITE_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

/// Sets or clears one role. `value: None` clears it (deletes the key) rather than writing a JSON
/// `null`. Validates the selector shape before ever entering the write lock.
pub async fn set_model_role(
    role: &str,
    value: Option<&str>,
) -> Result<SetModelRoleResult, OmpConfigError> {
    if let Some(selector) = value {
        assert_valid_selector(selector)?;
    }
    let _guard = MODEL_ROLES_WRITE_LOCK.lock().await;
    set_model_role_now(role, value).await
}

async fn set_model_role_now(
    role: &str,
    value: Option<&str>,
) -> Result<SetModelRoleResult, OmpConfigError> {
    let stripped_env = env_without_role_overrides(&current_env());
    let current = read_model_roles_raw(Some(&stripped_env)).await?;
    let next = match merge_model_role(&current, role, value) {
        None => {
            return Ok(SetModelRoleResult {
                roles: string_entries_only(&current),
                overridden_by: None,
            })
        }
        Some(next) => next,
    };
    let response = set_config("modelRoles", &Value::Object(next), Some(&stripped_env)).await?;
    let overridden_by = response
        .get("overriddenBy")
        .and_then(Value::as_str)
        .map(str::to_string);
    // Always re-read the TRUE effective record (full environment) after a successful write,
    // rather than trusting the write response -- matches `config.ts`'s own quality-gate fix.
    let roles = get_model_roles().await?;
    Ok(SetModelRoleResult {
        roles,
        overridden_by,
    })
}

/// Pure response-shape handling for `omp models --kind <kind> --json`: accepts either a bare
/// top-level array or `{ models: [...] }`, validating each row before trusting it. Exported for
/// direct unit testing.
pub fn parse_catalog_response(value: &Value) -> Result<Vec<ModelCatalogEntry>, OmpConfigError> {
    let rows: &Vec<Value> = if let Some(array) = value.as_array() {
        array
    } else if let Some(object) = value.as_object() {
        match object.get("models").and_then(Value::as_array) {
            Some(array) => array,
            None => {
                return Err(OmpConfigError::new(
                    OmpConfigErrorCode::ParseFailed,
                    "omp models returned neither an array nor { models: [...] }.",
                ))
            }
        }
    } else {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp models returned neither an array nor { models: [...] }.",
        ));
    };
    let mut entries = Vec::new();
    for row in rows {
        let Some(object) = row.as_object() else {
            continue;
        };
        let provider = object.get("provider").and_then(Value::as_str);
        let id = object.get("id").and_then(Value::as_str);
        let selector = object.get("selector").and_then(Value::as_str);
        let name = object.get("name").and_then(Value::as_str);
        if let (Some(provider), Some(id), Some(selector), Some(name)) =
            (provider, id, selector, name)
        {
            entries.push(ModelCatalogEntry {
                provider: provider.to_string(),
                id: id.to_string(),
                selector: selector.to_string(),
                name: name.to_string(),
            });
        }
    }
    Ok(entries)
}

/// `omp models --kind <kind> --json`: a read-only catalog listing, independent of any live RPC
/// session (how the Role picker gets model options).
pub async fn list_catalog_models(kind: &str) -> Result<Vec<ModelCatalogEntry>, OmpConfigError> {
    let response = crate::omp::config::run_json(
        &["models", "--kind", kind, "--json"],
        "Could not read the model catalog from omp.",
    )
    .await?;
    parse_catalog_response(&response)
}

// ---------------------------------------------------------------------------
// IPC handlers.
// ---------------------------------------------------------------------------

pub fn model_roles_list(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let roles = get_model_roles().await.map_err(|err| to_ipc_error(&err))?;
        Ok(serde_json::to_value(roles).expect("Record<string,string> is always JSON-serialisable"))
    })
}

pub fn model_roles_set(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let role = match args.first().and_then(Value::as_str) {
            Some(role) if is_model_role_id(role) => role.to_string(),
            _ => {
                return Err(invalid_argument(
                    "modelRoles.set expects a known model role",
                ))
            }
        };
        let value_arg = args.get(1).cloned().unwrap_or(Value::Null);
        let value = match &value_arg {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            _ => {
                return Err(invalid_argument(
                    "modelRoles.set expects a string value or null",
                ))
            }
        };
        let result = set_model_role(&role, value.as_deref())
            .await
            .map_err(|err| to_ipc_error(&err))?;
        let mut out = Map::new();
        out.insert(
            "roles".to_string(),
            serde_json::to_value(result.roles).expect("roles is always JSON-serialisable"),
        );
        if let Some(overridden_by) = result.overridden_by {
            out.insert("overriddenBy".to_string(), Value::String(overridden_by));
        }
        Ok(Value::Object(out))
    })
}

pub fn model_roles_list_catalog(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let kind = match args.first().and_then(Value::as_str) {
            Some(kind) if is_catalog_kind(kind) => kind.to_string(),
            _ => {
                return Err(invalid_argument(
                    "modelRoles.listCatalog expects a known catalog kind",
                ))
            }
        };
        let entries = list_catalog_models(&kind)
            .await
            .map_err(|err| to_ipc_error(&err))?;
        Ok(serde_json::to_value(entries).expect("ModelCatalogEntry is always JSON-serialisable"))
    })
}

// Split into a sibling file (not inline here) only to keep this file's handler/business-logic
// line count comfortably under this build's 600-line-per-file cap once the full ported test
// suite (below) is included.
#[cfg(test)]
#[path = "model_roles_tests.rs"]
mod tests;
