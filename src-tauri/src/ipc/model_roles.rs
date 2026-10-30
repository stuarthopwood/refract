// IPC handlers for `modelRoles.*` and the read-merge-write logic over `omp::config`.
// Entry points re-check role ids and catalog kinds so no unvalidated value reaches `omp` argv.

use std::collections::HashMap;

use serde_json::{Map, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::omp::config::{
    get_config_with, run_json_with, set_config_with, OmpConfigError, OmpConfigErrorCode,
    OmpExecutor, RealOmpExecutor,
};

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

const MODEL_ROLE_IDS: [&str; 16] = [
    "default",
    "smol",
    "slow",
    "vision",
    "plan",
    "commit",
    "tiny",
    "widget",
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
    /// Whether the model supports a reasoning budget; drives the "Off" radio option.
    pub reasoning: bool,
    /// Supported reasoning levels; `None` for a non-reasoning model.
    pub thinking: Option<Vec<String>>,
    /// OMP's reported context window; `None` when the row omits it.
    #[serde(rename = "contextWindow")]
    pub context_window: Option<i64>,
}

// Stripped from the merge-read and `config set` so a runtime env override never becomes the persisted baseline.
// Applied via `Command::env_remove`, not a rebuilt env map, which panics on non-UTF-8 values.
const ROLE_OVERRIDE_ENV_VARS: [&str; 4] = [
    "PI_SMOL_MODEL",
    "PI_SLOW_MODEL",
    "PI_PLAN_MODEL",
    "PI_CONFIG_FILES",
];

/// Validates a plain, non-array object; `Value::Null` is an empty record.
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

/// Keeps string entries only; blank ones are dropped so no empty "Inherited" label shows.
pub fn string_entries_only(record: &Map<String, Value>) -> HashMap<String, String> {
    record
        .iter()
        .filter_map(|(key, entry)| match entry {
            Value::String(text) if !text.trim().is_empty() => Some((key.clone(), text.clone())),
            _ => None,
        })
        .collect()
}

/// Applies one role change without touching other keys. Returns `None` when clearing an absent role.
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

async fn read_model_roles_raw_with(
    executor: &dyn OmpExecutor,
    strip_env_vars: &[&str],
) -> Result<Map<String, Value>, OmpConfigError> {
    let response = get_config_with(executor, "modelRoles", strip_env_vars).await?;
    // A missing `value` field is a malformed read and must fail closed, not look like an empty record.
    let Some(inner) = response.get("value") else {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::ParseFailed,
            "omp config returned no value field for modelRoles.",
        ));
    };
    raw_model_roles_record(inner)
}

/// The whole record as the effective value, env overrides included; for display only.
pub async fn get_model_roles_with(
    executor: &dyn OmpExecutor,
) -> Result<HashMap<String, String>, OmpConfigError> {
    let raw = read_model_roles_raw_with(executor, &[]).await?;
    Ok(string_entries_only(&raw))
}

pub async fn get_model_roles() -> Result<HashMap<String, String>, OmpConfigError> {
    get_model_roles_with(&RealOmpExecutor).await
}

/// Retries once on an empty record, since an empty read can be transient. A non-empty partial read is not detected.
pub async fn get_model_roles_reliable() -> Result<HashMap<String, String>, OmpConfigError> {
    let first = get_model_roles().await?;
    if !first.is_empty() {
        return Ok(first);
    }
    log::debug!("get_model_roles_reliable: empty modelRoles, retrying once");
    let retry = get_model_roles().await?;
    if !retry.is_empty() {
        log::debug!(
            "get_model_roles_reliable: retry recovered {} modelRoles keys",
            retry.len()
        );
    }
    Ok(retry)
}

const MAX_ROLE_VALUE_LENGTH: usize = 512;

// Also rejects C1 controls, line separators, and bidi/zero-width/BOM characters.
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

/// Serialises the whole read-merge-write so concurrent role edits cannot lose an update.
static MODEL_ROLES_WRITE_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

/// Sets or clears one role; `None` deletes the key rather than writing JSON `null`.
pub async fn set_model_role_with(
    executor: &dyn OmpExecutor,
    role: &str,
    value: Option<&str>,
) -> Result<SetModelRoleResult, OmpConfigError> {
    if !is_model_role_id(role) {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::InvalidValue,
            format!("Unknown model role: {role}"),
        ));
    }
    if let Some(selector) = value {
        assert_valid_selector(selector)?;
    }
    let _guard = MODEL_ROLES_WRITE_LOCK.lock().await;
    set_model_role_now_with(executor, role, value).await
}

pub async fn set_model_role(
    role: &str,
    value: Option<&str>,
) -> Result<SetModelRoleResult, OmpConfigError> {
    set_model_role_with(&RealOmpExecutor, role, value).await
}

async fn set_model_role_now_with(
    executor: &dyn OmpExecutor,
    role: &str,
    value: Option<&str>,
) -> Result<SetModelRoleResult, OmpConfigError> {
    let current = read_model_roles_raw_with(executor, &ROLE_OVERRIDE_ENV_VARS).await?;
    let next = match merge_model_role(&current, role, value) {
        None => {
            return Ok(SetModelRoleResult {
                roles: string_entries_only(&current),
                overridden_by: None,
            })
        }
        Some(next) => next,
    };
    let response = set_config_with(
        executor,
        "modelRoles",
        &Value::Object(next),
        &ROLE_OVERRIDE_ENV_VARS,
    )
    .await?;
    let overridden_by = response
        .get("overriddenBy")
        .and_then(Value::as_str)
        .map(str::to_string);
    // Re-read the full effective record after a write rather than trusting the write response.
    let roles = get_model_roles_with(executor).await?;
    Ok(SetModelRoleResult {
        roles,
        overridden_by,
    })
}

/// Parses `omp models --json`, accepting a bare array or `{ models: [...] }`.
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
            // `reasoning` defaults to false when absent; `thinking` is None for a non-array field.
            let reasoning = object
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let thinking = object
                .get("thinking")
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(|level| level.as_str().map(str::to_string))
                        .collect()
                });
            entries.push(ModelCatalogEntry {
                provider: provider.to_string(),
                id: id.to_string(),
                selector: selector.to_string(),
                name: name.to_string(),
                reasoning,
                thinking,
                context_window: object.get("contextWindow").and_then(Value::as_i64),
            });
        }
    }
    Ok(entries)
}

/// Read-only catalog listing for the Role picker; re-checks `kind` for direct callers.
pub async fn list_catalog_models_with(
    executor: &dyn OmpExecutor,
    kind: &str,
) -> Result<Vec<ModelCatalogEntry>, OmpConfigError> {
    if !is_catalog_kind(kind) {
        return Err(OmpConfigError::new(
            OmpConfigErrorCode::InvalidValue,
            format!("Unknown catalog kind: {kind}"),
        ));
    }
    let response = run_json_with(
        executor,
        &["models", "--kind", kind, "--json"],
        "Could not read the model catalog from omp.",
    )
    .await?;
    parse_catalog_response(&response)
}

pub async fn list_catalog_models(kind: &str) -> Result<Vec<ModelCatalogEntry>, OmpConfigError> {
    list_catalog_models_with(&RealOmpExecutor, kind).await
}

pub fn model_roles_list(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let roles = get_model_roles().await.map_err(|err| to_ipc_error(&err))?;
        Ok(serde_json::to_value(roles).expect("Record<string,string> is always JSON-serialisable"))
    })
}

pub fn model_roles_set(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let role = match args.first().and_then(Value::as_str) {
            Some(role) if is_model_role_id(role) => role.to_string(),
            _ => {
                return Err(invalid_argument(
                    "modelRoles.set expects a known model role",
                ))
            }
        };
        // Only an explicit `null` (clear) or a string (set) is accepted; anything else is invalid.
        let value = match args.get(1) {
            Some(Value::Null) => None,
            Some(Value::String(text)) => Some(text.clone()),
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
        // Clone before `result.roles` moves into the reply; the sweep reuses this map instead of re-reading.
        let roles_for_sweep = result.roles.clone();
        out.insert(
            "roles".to_string(),
            serde_json::to_value(result.roles).expect("roles is always JSON-serialisable"),
        );
        if let Some(overridden_by) = result.overridden_by {
            out.insert("overriddenBy".to_string(), Value::String(overridden_by));
        }
        // Propagate the change to open Sessions on this role, only after a successful write.
        // Awaited, so the reply carries the propagation summary.
        let propagation = state
            .session_manager
            .apply_role_change(&role, roles_for_sweep)
            .await;
        out.insert(
            "propagation".to_string(),
            serde_json::to_value(propagation)
                .expect("RoleChangeSummary is always JSON-serialisable"),
        );
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

// Tests live in a sibling file to keep this file under the 600-line cap.
#[cfg(test)]
#[path = "model_roles_tests.rs"]
mod tests;
